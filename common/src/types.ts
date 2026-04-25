export interface WalletEntry {
  address: string;
  circleWalletId: string;
}

export interface Deployments {
  arcRpc: string;
  arcChainId: number;
  contracts: {
    dataTypeRegistry: string;
    sensorRegistry: string;
    cairnAggregator: string;
    cairnAttestation: string;
  };
  wallets: {
    treasury: WalletEntry;
    aggregator: WalletEntry;
    policyholder: WalletEntry;
    operator1: WalletEntry;
    operator2: WalletEntry;
    operator3: WalletEntry;
    operator4: WalletEntry;
    operator5: WalletEntry;
    customer: WalletEntry;
  };
}

export interface Reading {
  sensorId: number;
  sensorWallet: string;
  value: number;
  timestamp: number;
  signature: string;
}

export interface DataTypeMetadata {
  id: string;
  unit: string;
  minValue: number;
  maxValue: number;
  expectedVariance: number;
}

export interface VerificationResult {
  verifiedValue: number;
  accepted: Reading[];
  outliers: Reading[];
  malformed: Reading[];
  confidenceBps: number;
  payloadHash: string;
}
