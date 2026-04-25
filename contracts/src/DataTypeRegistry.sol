// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Registry of canonical sensor data types.
/// All numeric fields (minValue, maxValue, expectedVariance) are scaled × 1e6.
/// Off-chain consumers divide by 1e6 to get float values.
contract DataTypeRegistry is Ownable {
    struct DataType {
        bytes32 id;
        string  unit;
        int256  minValue;          // × 1e6
        int256  maxValue;          // × 1e6
        uint256 expectedVariance;  // × 1e6
        bool    exists;
    }

    mapping(bytes32 => DataType) public types;
    bytes32[] public typeIds;

    event DataTypeRegistered(bytes32 indexed id, string unit);

    constructor() Ownable(msg.sender) {
        _reg("weather.temperature_c",      "degC",  -50_000_000,  60_000_000,  2_000_000);
        _reg("weather.humidity_pct",       "pct",            0, 100_000_000,  5_000_000);
        _reg("weather.precipitation_mm_h", "mm/h",           0, 200_000_000,  2_000_000);
        _reg("weather.wind_ms",            "m/s",            0,  80_000_000,  2_000_000);
        _reg("air.pm25_ugm3",              "ug/m3",          0, 500_000_000, 10_000_000);
        _reg("air.pm10_ugm3",              "ug/m3",          0, 600_000_000, 15_000_000);
        _reg("seismic.velocity_mms",       "mm/s",           0, 100_000_000,  1_000_000);
        _reg("radiation.dose_usvh",        "uSv/h",          0,  10_000_000,    100_000);
    }

    function registerType(
        bytes32        id,
        string calldata unit,
        int256         minValue,
        int256         maxValue,
        uint256        expectedVariance
    ) external onlyOwner {
        _reg(id, unit, minValue, maxValue, expectedVariance);
    }

    function getType(bytes32 id) external view returns (DataType memory) {
        return types[id];
    }

    function getTypeCount() external view returns (uint256) {
        return typeIds.length;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _reg(
        bytes32        id,
        string memory  unit,
        int256         minValue,
        int256         maxValue,
        uint256        expectedVariance
    ) internal {
        require(!types[id].exists, "DataTypeRegistry: already registered");
        require(maxValue > minValue,  "DataTypeRegistry: invalid range");
        types[id] = DataType({
            id:               id,
            unit:             unit,
            minValue:         minValue,
            maxValue:         maxValue,
            expectedVariance: expectedVariance,
            exists:           true
        });
        typeIds.push(id);
        emit DataTypeRegistered(id, unit);
    }
}
