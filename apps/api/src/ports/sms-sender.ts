/** A text message to an E.164 number (ADR 0011). */
export interface SmsMessage {
  readonly to: string;
  readonly text: string;
}

/** No free provider exists for Brazil (ADR 0011): only a log adapter until the owner picks one. */
export interface SmsSenderPort {
  send(message: SmsMessage): Promise<void>;
}
