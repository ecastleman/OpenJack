export type BuyTxState = "IDLE" | "SIGNING" | "PENDING" | "CONFIRMED" | "FAILED";

export const BUY_TX_STATE: Readonly<Record<BuyTxState, BuyTxState>>;

export type BuyPreparedFlowContext<TPrepared, TSigned, TSubmission> = {
  prepared: TPrepared;
  signed: TSigned;
  submission: TSubmission;
};

export type BuyPreparedTxFlowArgs<TPrepared, TSigned, TSubmission> = {
  prepare: () => Promise<TPrepared>;
  sign: (prepared: TPrepared) => Promise<TSigned>;
  send: (args: { prepared: TPrepared; signed: TSigned }) => Promise<TSubmission>;
  confirm: (args: BuyPreparedFlowContext<TPrepared, TSigned, TSubmission>) => Promise<void>;
  onState?: (state: BuyTxState) => void;
};

export function runPreparedTxFlow<TPrepared, TSigned, TSubmission>(
  args: BuyPreparedTxFlowArgs<TPrepared, TSigned, TSubmission>,
): Promise<BuyPreparedFlowContext<TPrepared, TSigned, TSubmission>>;
