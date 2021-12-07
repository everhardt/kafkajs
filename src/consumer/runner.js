const { EventEmitter } = require('events')
const Long = require('../utils/long')
const createRetry = require('../retry')
const { KafkaJSError } = require('../errors')

const {
  events: { START_BATCH_PROCESS, END_BATCH_PROCESS, REBALANCING },
} = require('./instrumentationEvents')

const isRebalancing = e =>
  e.type === 'REBALANCE_IN_PROGRESS' || e.type === 'NOT_COORDINATOR_FOR_GROUP'

const isKafkaJSError = e => e instanceof KafkaJSError
const isSameOffset = (offsetA, offsetB) => Long.fromValue(offsetA).equals(Long.fromValue(offsetB))
const CONSUMING_START = 'consuming-start'
const CONSUMING_STOP = 'consuming-stop'

module.exports = class Runner extends EventEmitter {
  /**
   * @param {object} options
   * @param {import("../../types").Logger} options.logger
   * @param {import("./consumerGroup")} options.consumerGroup
   * @param {import("../instrumentation/emitter")} options.instrumentationEmitter
   * @param {boolean} [options.eachBatchAutoResolve=true]
   * @param {(payload: import("../../types").EachBatchPayload) => Promise<void>} options.eachBatch
   * @param {(payload: import("../../types").EachMessagePayload) => Promise<void>} options.eachMessage
   * @param {number} [options.heartbeatInterval]
   * @param {(reason: Error) => void} options.onCrash
   * @param {import("../../types").RetryOptions} [options.retry]
   * @param {boolean} [options.autoCommit=true]
   */
  constructor({
    logger,
    consumerGroup,
    instrumentationEmitter,
    eachBatchAutoResolve = true,
    eachBatch,
    eachMessage,
    heartbeatInterval,
    onCrash,
    retry,
    autoCommit = true,
  }) {
    super()
    this.logger = logger.namespace('Runner')
    this.consumerGroup = consumerGroup
    this.instrumentationEmitter = instrumentationEmitter
    this.eachBatchAutoResolve = eachBatchAutoResolve
    this.eachBatch = eachBatch
    this.eachMessage = eachMessage
    this.heartbeatInterval = heartbeatInterval
    this.retrier = createRetry(Object.assign({}, retry))
    this.onCrash = onCrash
    this.autoCommit = autoCommit

    this.running = false
    this.consuming = false
  }

  get consuming() {
    return this._consuming
  }

  set consuming(value) {
    if (this._consuming !== value) {
      this._consuming = value
      this.emit(value ? CONSUMING_START : CONSUMING_STOP)
    }
  }

  async joinAndSync() {
    if (!this.running) return

    try {
      await this.consumerGroup.joinAndSync()
    } catch (e) {
      return this.onCrash(e)
    }
  }

  async start() {
    if (this.running) return
    this.running = true

    this.scheduleConsume()
  }

  async stop() {
    this.logger.debug('stop()')

    if (!this.running) return
    this.running = false

    this.logger.debug('stop consumer group', {
      groupId: this.consumerGroup.groupId,
      memberId: this.consumerGroup.memberId,
    })

    await this.waitForConsumer()
  }

  waitForConsumer() {
    return new Promise(resolve => {
      if (!this.consuming) {
        return resolve()
      }

      this.logger.debug('waiting for consumer to finish...', {
        groupId: this.consumerGroup.groupId,
        memberId: this.consumerGroup.memberId,
      })

      this.once(CONSUMING_STOP, () => {
        this.logger.debug('consumer finished', {
          groupId: this.consumerGroup.groupId,
          memberId: this.consumerGroup.memberId,
        })

        resolve()
      })
    })
  }

  async processEachMessage(batch) {
    const { topic, partition } = batch

    for (const message of batch.messages) {
      if (!this.running || this.consumerGroup.hasSeekOffset({ topic, partition })) {
        break
      }

      try {
        await this.eachMessage({ topic, partition, message })
      } catch (e) {
        if (!isKafkaJSError(e)) {
          this.logger.error(`Error when calling eachMessage`, {
            topic,
            partition,
            offset: message.offset,
            stack: e.stack,
            error: e,
          })
        }

        // In case of errors, commit the previously consumed offsets unless autoCommit is disabled
        await this.autoCommitOffsets()
        throw e
      }

      this.consumerGroup.resolveOffset({ topic, partition, offset: message.offset })
      await this.consumerGroup.heartbeat({ interval: this.heartbeatInterval })
      await this.autoCommitOffsetsIfNecessary()
    }
  }

  async processEachBatch(batch) {
    const { topic, partition } = batch
    const lastFilteredMessage = batch.messages[batch.messages.length - 1]

    try {
      await this.eachBatch({
        batch,
        resolveOffset: offset => {
          /**
           * The transactional producer generates a control record after committing the transaction.
           * The control record is the last record on the RecordBatch, and it is filtered before it
           * reaches the eachBatch callback. When disabling auto-resolve, the user-land code won't
           * be able to resolve the control record offset, since it never reaches the callback,
           * causing stuck consumers as the consumer will never move the offset marker.
           *
           * When the last offset of the batch is resolved, we should automatically resolve
           * the control record offset as this entry doesn't have any meaning to the user-land code,
           * and won't interfere with the stream processing.
           *
           * @see https://github.com/apache/kafka/blob/9aa660786e46c1efbf5605a6a69136a1dac6edb9/clients/src/main/java/org/apache/kafka/clients/consumer/internals/Fetcher.java#L1499-L1505
           */
          const offsetToResolve =
            lastFilteredMessage && isSameOffset(offset, lastFilteredMessage.offset)
              ? batch.lastOffset()
              : offset

          this.consumerGroup.resolveOffset({ topic, partition, offset: offsetToResolve })
        },
        heartbeat: async () => {
          await this.consumerGroup.heartbeat({ interval: this.heartbeatInterval })
        },
        /**
         * Commit offsets if provided. Otherwise commit most recent resolved offsets
         * if the autoCommit conditions are met.
         *
         * @param {OffsetsByTopicPartition} [offsets] Optional.
         */
        commitOffsetsIfNecessary: async offsets => {
          return offsets
            ? this.consumerGroup.commitOffsets(offsets)
            : this.consumerGroup.commitOffsetsIfNecessary()
        },
        uncommittedOffsets: () => this.consumerGroup.uncommittedOffsets(),
        isRunning: () => this.running,
        isStale: () => this.consumerGroup.hasSeekOffset({ topic, partition }),
      })
    } catch (e) {
      if (!isKafkaJSError(e)) {
        this.logger.error(`Error when calling eachBatch`, {
          topic,
          partition,
          offset: batch.firstOffset(),
          stack: e.stack,
          error: e,
        })
      }

      // eachBatch has a special resolveOffset which can be used
      // to keep track of the messages
      await this.autoCommitOffsets()
      throw e
    }

    // resolveOffset for the last offset can be disabled to allow the users of eachBatch to
    // stop their consumers without resolving unprocessed offsets (issues/18)
    if (this.eachBatchAutoResolve) {
      this.consumerGroup.resolveOffset({ topic, partition, offset: batch.lastOffset() })
    }
  }

  async scheduleConsume() {
    while (this.running) {
      this.consuming = true
      await this.consume()
      this.consuming = false
    }
  }

  async consume() {
    const batch = await this.consumerGroup.fetcher.next()

    if (!this.running || !batch || batch.isEmpty()) {
      return
    }

    const startBatchProcess = Date.now()
    const payload = {
      topic: batch.topic,
      partition: batch.partition,
      highWatermark: batch.highWatermark,
      offsetLag: batch.offsetLag(),
      /**
       * @since 2019-06-24 (>= 1.8.0)
       *
       * offsetLag returns the lag based on the latest offset in the batch, to
       * keep the event backward compatible we just introduced "offsetLagLow"
       * which calculates the lag based on the first offset in the batch
       */
      offsetLagLow: batch.offsetLagLow(),
      batchSize: batch.messages.length,
      firstOffset: batch.firstOffset(),
      lastOffset: batch.lastOffset(),
    }

    this.instrumentationEmitter.emit(START_BATCH_PROCESS, payload)

    if (this.eachMessage) {
      await this.processEachMessage(batch)
    } else if (this.eachBatch) {
      await this.processEachBatch(batch)
    }

    this.instrumentationEmitter.emit(END_BATCH_PROCESS, {
      ...payload,
      duration: Date.now() - startBatchProcess,
    })

    await this.autoCommitOffsets() // TODO: For a single batch (topic, partition) maybe?
    await this.consumerGroup.heartbeat({ interval: this.heartbeatInterval })
  }

  autoCommitOffsets() {
    if (this.autoCommit) {
      return this.consumerGroup.commitOffsets()
    }
  }

  autoCommitOffsetsIfNecessary() {
    if (this.autoCommit) {
      return this.consumerGroup.commitOffsetsIfNecessary()
    }
  }

  commitOffsets(offsets) {
    if (!this.running) {
      this.logger.debug('consumer not running, exiting', {
        groupId: this.consumerGroup.groupId,
        memberId: this.consumerGroup.memberId,
        offsets,
      })
      return
    }

    return this.retrier(async (bail, retryCount, retryTime) => {
      try {
        await this.consumerGroup.commitOffsets(offsets)
      } catch (e) {
        if (!this.running) {
          this.logger.debug('consumer not running, exiting', {
            error: e.message,
            groupId: this.consumerGroup.groupId,
            memberId: this.consumerGroup.memberId,
            offsets,
          })
          return
        }

        if (isRebalancing(e)) {
          this.logger.error('The group is rebalancing, re-joining', {
            groupId: this.consumerGroup.groupId,
            memberId: this.consumerGroup.memberId,
            error: e.message,
            retryCount,
            retryTime,
          })

          this.instrumentationEmitter.emit(REBALANCING, {
            groupId: this.consumerGroup.groupId,
            memberId: this.consumerGroup.memberId,
          })

          setImmediate(() => this.joinAndSync())

          bail(new KafkaJSError(e))
        }

        if (e.type === 'UNKNOWN_MEMBER_ID') {
          this.logger.error('The coordinator is not aware of this member, re-joining the group', {
            groupId: this.consumerGroup.groupId,
            memberId: this.consumerGroup.memberId,
            error: e.message,
            retryCount,
            retryTime,
          })

          this.consumerGroup.memberId = null
          setImmediate(() => this.joinAndSync())

          bail(new KafkaJSError(e))
        }

        if (e.name === 'KafkaJSNotImplemented') {
          return bail(e)
        }

        this.logger.debug('Error while committing offsets, trying again...', {
          groupId: this.consumerGroup.groupId,
          memberId: this.consumerGroup.memberId,
          error: e.message,
          stack: e.stack,
          retryCount,
          retryTime,
          offsets,
        })

        throw e
      }
    })
  }
}
