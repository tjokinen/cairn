// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/DataTypeRegistry.sol";

contract DataTypeRegistryTest is Test {
    DataTypeRegistry reg;

    bytes32 constant TEMP_ID  = "weather.temperature_c";
    bytes32 constant HUMID_ID = "weather.humidity_pct";

    function setUp() public {
        reg = new DataTypeRegistry();
    }

    // ── Pre-registered types ──────────────────────────────────────────────────

    function test_Constructor_RegistersEightTypes() public view {
        assertEq(reg.getTypeCount(), 8);
    }

    function test_Constructor_TemperatureRange() public view {
        DataTypeRegistry.DataType memory t = reg.getType(TEMP_ID);
        assertTrue(t.exists);
        assertEq(t.minValue,         -50_000_000);
        assertEq(t.maxValue,          60_000_000);
        assertEq(t.expectedVariance,   2_000_000);
        assertEq(keccak256(bytes(t.unit)), keccak256(bytes("degC")));
    }

    function test_Constructor_AllEightTypesExist() public view {
        bytes32[8] memory ids = [
            bytes32("weather.temperature_c"),
            bytes32("weather.humidity_pct"),
            bytes32("weather.precipitation_mm_h"),
            bytes32("weather.wind_ms"),
            bytes32("air.pm25_ugm3"),
            bytes32("air.pm10_ugm3"),
            bytes32("seismic.velocity_mms"),
            bytes32("radiation.dose_usvh")
        ];
        for (uint256 i = 0; i < 8; i++) {
            assertTrue(reg.getType(ids[i]).exists, "type missing");
        }
    }

    // ── registerType ──────────────────────────────────────────────────────────

    function test_RegisterType_EmitsEvent() public {
        bytes32 id = "custom.sensor_x";
        vm.expectEmit(true, false, false, true);
        emit DataTypeRegistry.DataTypeRegistered(id, "units");
        reg.registerType(id, "units", 0, 1_000_000, 100_000);
    }

    function test_RegisterType_StoresCorrectly() public {
        bytes32 id = "custom.sensor_x";
        reg.registerType(id, "units", -1_000_000, 1_000_000, 50_000);
        DataTypeRegistry.DataType memory t = reg.getType(id);
        assertTrue(t.exists);
        assertEq(t.minValue,  -1_000_000);
        assertEq(t.maxValue,   1_000_000);
        assertEq(t.expectedVariance, 50_000);
    }

    function test_RegisterType_RevertsIfAlreadyRegistered() public {
        vm.expectRevert("DataTypeRegistry: already registered");
        reg.registerType(TEMP_ID, "degC", 0, 1_000_000, 100_000);
    }

    function test_RegisterType_RevertsIfNotOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        reg.registerType("new.type", "u", 0, 1_000_000, 100_000);
    }

    function test_RegisterType_RevertsIfInvalidRange() public {
        vm.expectRevert("DataTypeRegistry: invalid range");
        reg.registerType("bad.range", "u", 1_000_000, 0, 100_000);
    }

    function test_GetType_NonExistentReturnsEmpty() public view {
        DataTypeRegistry.DataType memory t = reg.getType("nonexistent");
        assertFalse(t.exists);
    }
}
