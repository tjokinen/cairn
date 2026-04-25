export interface SensorInfo {
  sensorId:     number;
  wallet:       string;
  endpointUrl:  string;
  dataTypes:    string[];   // decoded from bytes32
  lat:          number;     // degrees (divided by 1e6 from chain)
  lon:          number;
  ratePerQuery: number;     // USDC smallest units
  reputation:   bigint;     // 0–1e18
  active:       boolean;
}

export interface SensorReading {
  sensorId:     number;
  sensorWallet: string;
  value:        number;
  timestamp:    number;
  signature:    string;
  dataType:     string;
  unit:         string;
}

export interface QueryContext {
  dataType:       string;
  lat:            number;
  lon:            number;
  radiusKm:       number;
  quorum:         number;
  selectedSensors: SensorInfo[];
  basePrice:      number;   // sum of selected sensor rates
  customerPrice:  number;   // basePrice * 102/100
}
