import type { AppState, BusEvent, SensorState, SlashEvent } from './types';
import { STATIC_SENSORS } from './types';

const MAX_TX_EVENTS = 200;
let _eventId = 0;

function initSensors(): Map<number, SensorState> {
  const m = new Map<number, SensorState>();
  for (const s of STATIC_SENSORS) {
    m.set(s.sensorId, { ...s, reputation: 1.0, active: true, earnings: 0, queryCount: 0, repHistory: [1.0] });
  }
  return m;
}

export function initState(): AppState {
  return {
    sensors:          initSensors(),
    txEvents:         [],
    totalTxCount:     0,
    totalSettlements: 0,
    operatorEarnings: 0,
    protocolTreasury: 0,
    policy: {
      policyId:       'policy-001',
      status:         'monitoring',
      premiumBalance: '0',
      latestValue:    null,
      history:        [],
      lastPaid:       null,
    },
    slashEvents: [],
    replayMode:  false,
    wsConnected: false,
  };
}

function pushTx(state: AppState, event: BusEvent): AppState {
  const entry = { id: _eventId++, ts: Date.now(), event };
  const txEvents = [entry, ...state.txEvents].slice(0, MAX_TX_EVENTS);
  return { ...state, txEvents, totalTxCount: state.totalTxCount + 1 };
}

function updateSensor(state: AppState, id: number, patch: Partial<SensorState>): AppState {
  const sensors = new Map(state.sensors);
  const existing = sensors.get(id);
  if (existing) sensors.set(id, { ...existing, ...patch });
  return { ...state, sensors };
}

export function reduce(state: AppState, event: BusEvent): AppState {
  let s = pushTx(state, event);

  switch (event.type) {
    case 'chain.sensor_registered': {
      const sensors = new Map(s.sensors);
      const existing = sensors.get(event.sensorId);
      sensors.set(event.sensorId, {
        sensorId:     event.sensorId,
        name:         existing?.name ?? `Sensor #${event.sensorId}`,
        wallet:       event.wallet,
        lat:          event.lat,
        lon:          event.lon,
        dataTypes:    event.dataTypes,
        ratePerQuery: parseInt(event.ratePerQuery) / 1e6,
        reputation:   existing?.reputation ?? 1.0,
        active:       true,
        earnings:     existing?.earnings ?? 0,
        queryCount:   existing?.queryCount ?? 0,
        repHistory:   existing?.repHistory ?? [1.0],
      });
      return { ...s, sensors };
    }

    case 'chain.sensor_deactivated':
      return updateSensor(s, event.sensorId, { active: false });

    case 'chain.reputation_updated': {
      const sensors = new Map(s.sensors);
      const sensor  = sensors.get(event.sensorId);
      if (sensor) {
        const rep = Number(BigInt(event.newReputation)) / 1e18;
        const repHistory = [...sensor.repHistory, rep].slice(-20);
        sensors.set(event.sensorId, { ...sensor, reputation: rep, repHistory });
      }
      return { ...s, sensors };
    }

    case 'chain.slashed': {
      const slash: SlashEvent = {
        sensorId:       event.sensorId,
        amount:         event.amount,
        remainingStake: event.remainingStake,
        anomalyMag:     null,
        timestamp:      Date.now(),
      };
      s = updateSensor(s, event.sensorId, { active: !event.autoDeactivated });
      return { ...s, slashEvents: [slash, ...s.slashEvents] };
    }

    case 'chain.operator_paid': {
      const amount = parseInt(event.amount);
      const sensor = s.sensors.get(event.sensorId);
      const newEarnings  = (sensor?.earnings ?? 0) + amount;
      const newQueryCount = (sensor?.queryCount ?? 0) + 1;
      s = updateSensor(s, event.sensorId, { earnings: newEarnings, queryCount: newQueryCount });
      return { ...s, operatorEarnings: s.operatorEarnings + amount, totalSettlements: s.totalSettlements + 1 };
    }

    case 'chain.protocol_fee':
      return { ...s, protocolTreasury: s.protocolTreasury + parseInt(event.amount) };

    case 'query.slashed': {
      // Aggregator-side slash notification; match latest outlier reading for anomaly magnitude
      const slash: SlashEvent = {
        sensorId:       event.sensorId,
        amount:         '0',
        remainingStake: '0',
        anomalyMag:     null,
        timestamp:      Date.now(),
      };
      return { ...s, slashEvents: [slash, ...s.slashEvents] };
    }

    case 'insurance.snapshot': {
      const policy = {
        ...s.policy,
        policyId:       event.policyId,
        status:         event.status,
        premiumBalance: event.premiumBalance,
        latestValue:    event.latestValue,
        history:        event.history.slice(-20),
      };
      return { ...s, policy };
    }

    case 'insurance.paid': {
      const policy = {
        ...s.policy,
        status:   'paid',
        lastPaid: { txHash: event.txHash, attestationIds: event.attestationIds, amountUSDC: event.amountUSDC },
      };
      return { ...s, policy };
    }

    case 'replay.mode':
      return { ...s, replayMode: event.active };

    default:
      return s;
  }
}
