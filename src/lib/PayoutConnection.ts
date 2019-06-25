import { createConnection, Connection, DataAndMoneyStream } from 'ilp-protocol-stream'
import { URL } from 'url'
import axios from 'axios'

export const resolvePaymentPointer = (pointer: string) => {
  if (!pointer.startsWith('$')) {
    return pointer
  }

  const parsed = new URL('https://' + pointer.substring(1))

  if (parsed.pathname === '/') {
    parsed.pathname = '/.well-known/pay'
  }

  return parsed.href
}

export enum State {
  DISCONNECTED,
  CONNECTING,
  IDLE,
  SENDING
}

export class PayoutConnection {
  private spspUrl: string
  private connection?: Connection
  private stream?: DataAndMoneyStream
  private plugin: any

  private state = State.DISCONNECTED
  private closing = false

  private target = 0
  private sent = 0

  constructor (pointer: string, plugin: any) {
    this.spspUrl = resolvePaymentPointer(pointer)
    this.plugin = plugin
  }

  send (amount: number) {
    if (this.closing) {
      throw new Error('payout connection is closing')
    }

    this.target += amount

    if ((this.getState() === State.SENDING ||
      this.getState() === State.IDLE) &&
      this.stream
    ) {
      this.stream.setSendMax(this.getSendMax())
    } else {
      this.trySending()
    }
  }

  isIdle () {
    return this.getState() === State.IDLE
  }

  async close () {
    if (this.getState() === State.IDLE && this.connection) {
      this.closing = true
      await this.connection.destroy()
      await this.plugin.disconnect()
    }
  }

  private async spspQuery () {
    const { data } = await axios({
      url: this.spspUrl,
      method: 'GET',
      headers: {
        accept: 'application/spsp4+json'
      }
    })

    return {
      destinationAccount: data.destination_account,
      sharedSecret: Buffer.from(data.shared_secret, 'base64')
    }
  }

  private getSendMax () {
    return this.target - this.sent
  }

  // appeases type checker
  private getState () {
    return this.state
  }

  private setState (state: State) {
    this.state = state
  }

  private async safeTrySending () {
    this.trySending()
      .catch(() => {
        // TODO: backoff
        setTimeout(() => {
          this.safeTrySending()
        }, 2000)
      })
  }

  private async trySending () {
    if (this.getState() !== State.DISCONNECTED) {
      return
    }

    this.setState(State.CONNECTING)

    const spspParams = await this.spspQuery()
    const connection = await createConnection({
      plugin: this.plugin,
      ...spspParams
    })

    const stream = connection.createStream()
    this.stream = stream
    this.connection = connection
    const sendMax = this.getSendMax()

    if (sendMax > 0) {
      this.setState(State.SENDING)
      stream.setSendMax(this.getSendMax())
    } else {
      this.setState(State.IDLE)
    }

    let appliedSent = false
    let totalStreamAmount = 0
    const cleanUp = () => {
      setImmediate(() => {
        this.setState(State.DISCONNECTED)

        stream.removeListener('close', onClose)
        stream.removeListener('error', onError)
        stream.removeListener('outgoing_money', onOutgoingMoney)
        connection.removeListener('close', onClose)
        connection.removeListener('error', onError)

        if (!appliedSent) {
          this.sent += totalStreamAmount
        }

        if (this.getSendMax() > 0) {
          this.trySending()
        }
      })
    }

    const onClose = () => cleanUp()
    const onError = () => cleanUp()
    const onOutgoingMoney = (amount: string) => {
      totalStreamAmount += Number(amount)
      if (totalStreamAmount + this.sent === this.target) {
        this.setState(State.IDLE)
      }
    }

    connection.on('close', onClose)
    connection.on('error', onError)
    stream.on('close', onClose)
    stream.on('error', onError)
    stream.on('outgoing_money', onOutgoingMoney)
  }
}
