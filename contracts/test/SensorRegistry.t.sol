// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SensorRegistry.sol";
import "./mocks/MockERC20.sol";

contract SensorRegistryTest is Test {
    SensorRegistry reg;
    MockERC20      usdc;

    address treasury   = address(0x1111);
    address aggregator = address(0x2222);
    address operator1  = address(0x3333);
    address operator2  = address(0x4444);

    bytes32 constant TEMP_TYPE  = "weather.temperature_c";
    bytes32 constant WIND_TYPE  = "weather.wind_ms";
    bytes32 constant PM25_TYPE  = "air.pm25_ugm3";

    bytes32[] weatherTypes;
    bytes32[] multiTypes;

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        reg  = new SensorRegistry(treasury, address(usdc));
        reg.setAggregatorService(aggregator);

        weatherTypes = new bytes32[](2);
        weatherTypes[0] = TEMP_TYPE;
        weatherTypes[1] = WIND_TYPE;

        multiTypes = new bytes32[](3);
        multiTypes[0] = TEMP_TYPE;
        multiTypes[1] = WIND_TYPE;
        multiTypes[2] = PM25_TYPE;

        // Fund operators with 10 USDC each.
        // Cache constant to avoid the staticcall consuming vm.prank before approve fires.
        uint256 stake = reg.STAKE_REQUIRED();

        usdc.mint(operator1, stake);
        usdc.mint(operator2, stake);

        vm.prank(operator1);
        usdc.approve(address(reg), stake);

        vm.prank(operator2);
        usdc.approve(address(reg), stake);
    }

    // ── register ──────────────────────────────────────────────────────────────

    function test_Register_PullsStake() public {
        vm.prank(operator1);
        reg.register("http://op1:3001", weatherTypes, 18_900_000, -103_870_000, 100);

        assertEq(usdc.balanceOf(address(reg)), reg.STAKE_REQUIRED());
        assertEq(usdc.balanceOf(operator1),    0);
    }

    function test_Register_AssignsSequentialIds() public {
        vm.prank(operator1);
        uint256 id1 = reg.register("http://op1:3001", weatherTypes, 18_900_000, -103_870_000, 100);

        uint256 stake2 = reg.STAKE_REQUIRED();
        usdc.mint(operator2, stake2);
        vm.startPrank(operator2);
        usdc.approve(address(reg), stake2);
        uint256 id2 = reg.register("http://op2:3002", weatherTypes, 19_240_000, -103_720_000, 200);
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(reg.sensorCount(), 2);
    }

    function test_Register_StoresFields() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 18_900_000, -103_870_000, 100);

        (
            address wallet,
            string memory endpointUrl,
            ,
            int256  lat,
            int256  lon,
            uint256 ratePerQuery,
            uint256 stakeAmount,
            uint256 reputation,
            uint256 totalQueries,
            bool    active
        ) = _getSensor(id);

        assertEq(wallet,       operator1);
        assertEq(endpointUrl,  "http://op1:3001");
        assertEq(lat,           18_900_000);
        assertEq(lon,          -103_870_000);
        assertEq(ratePerQuery,  100);
        assertEq(stakeAmount,   reg.STAKE_REQUIRED());
        assertEq(reputation,    1e18);
        assertEq(totalQueries,  0);
        assertTrue(active);
    }

    function test_Register_EmitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit SensorRegistry.SensorRegistered(1, operator1, "http://op1:3001", weatherTypes, 18_900_000, -103_870_000, 100);
        vm.prank(operator1);
        reg.register("http://op1:3001", weatherTypes, 18_900_000, -103_870_000, 100);
    }

    function test_Register_RevertsWithoutApproval() public {
        address op3 = address(0x5555);
        usdc.mint(op3, reg.STAKE_REQUIRED());
        // No approve
        vm.prank(op3);
        vm.expectRevert();
        reg.register("http://op3:3003", weatherTypes, 0, 0, 100);
    }

    function test_Register_RevertsEmptyEndpoint() public {
        vm.prank(operator1);
        vm.expectRevert("SensorRegistry: empty endpoint");
        reg.register("", weatherTypes, 0, 0, 100);
    }

    // ── getSensorsForType ─────────────────────────────────────────────────────

    function test_GetSensorsForType_SingleType() public {
        vm.prank(operator1);
        reg.register("http://op1:3001", weatherTypes, 18_900_000, -103_870_000, 100);

        uint256[] memory ids = reg.getSensorsForType(TEMP_TYPE);
        assertEq(ids.length, 1);
        assertEq(ids[0],     1);
    }

    function test_GetSensorsForType_MultipleOperators() public {
        vm.prank(operator1);
        reg.register("http://op1:3001", weatherTypes, 18_900_000, -103_870_000, 100);

        uint256 stake2 = reg.STAKE_REQUIRED();
        usdc.mint(operator2, stake2);
        vm.prank(operator2);
        usdc.approve(address(reg), stake2);
        vm.prank(operator2);
        reg.register("http://op2:3002", weatherTypes, 19_240_000, -103_720_000, 200);

        uint256[] memory ids = reg.getSensorsForType(TEMP_TYPE);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
    }

    function test_GetSensorsForType_MultipleTypes() public {
        vm.prank(operator1);
        reg.register("http://op1:3001", multiTypes, 18_900_000, -103_870_000, 100);

        assertEq(reg.getSensorsForType(TEMP_TYPE).length, 1);
        assertEq(reg.getSensorsForType(WIND_TYPE).length, 1);
        assertEq(reg.getSensorsForType(PM25_TYPE).length, 1);
    }

    function test_GetSensorsForType_EmptyForUnknownType() public view {
        uint256[] memory ids = reg.getSensorsForType("unknown.type");
        assertEq(ids.length, 0);
    }

    // ── deactivate ────────────────────────────────────────────────────────────

    function test_Deactivate_ReturnsStake() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        vm.prank(operator1);
        reg.deactivate(id);

        assertEq(usdc.balanceOf(operator1), reg.STAKE_REQUIRED());
        assertEq(usdc.balanceOf(address(reg)), 0);

        (,,,,,, uint256 stakeAmount,,,bool active) = _getSensor(id);
        assertFalse(active);
        assertEq(stakeAmount, 0);
    }

    function test_Deactivate_EmitsEvent() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        vm.expectEmit(true, false, false, false);
        emit SensorRegistry.SensorDeactivated(id);
        vm.prank(operator1);
        reg.deactivate(id);
    }

    function test_Deactivate_RevertsIfNotOwner() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        vm.prank(operator2);
        vm.expectRevert("SensorRegistry: not owner");
        reg.deactivate(id);
    }

    // ── updateReputation ──────────────────────────────────────────────────────

    function test_UpdateReputation_PositiveDelta() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        // Reduce first so we have room to increase
        vm.prank(aggregator);
        reg.updateReputation(id, -1e17);

        (,,,,,,, uint256 repBefore,,) = _getSensor(id);

        vm.prank(aggregator);
        reg.updateReputation(id, 1e16);

        (,,,,,,, uint256 repAfter,,) = _getSensor(id);
        assertEq(repAfter, repBefore + 1e16);
    }

    function test_UpdateReputation_ClampsAtMaxOne() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        vm.prank(aggregator);
        reg.updateReputation(id, 1e18); // already at 1e18, can't exceed

        (,,,,,,, uint256 rep,,) = _getSensor(id);
        assertEq(rep, 1e18);
    }

    function test_UpdateReputation_ClampsAtZero() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        // Cache constants before setting prank to avoid staticcalls consuming vm.prank
        uint256 threshold = reg.SLASH_THRESHOLD();

        // Safe reduction: bring rep to just above slash threshold
        int256 safeReduction = int256(1e18) - int256(threshold) - 1e16;
        vm.prank(aggregator);
        reg.updateReputation(id, -safeReduction);

        // Now a huge negative should clamp at zero (will also trigger slash/deactivate, no revert)
        vm.prank(aggregator);
        reg.updateReputation(id, -int256(2e18));
        (,,,,,,, uint256 rep,,) = _getSensor(id);
        assertEq(rep, 0);
    }

    function test_UpdateReputation_RevertsIfNotAggregator() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        vm.prank(operator1);
        vm.expectRevert("SensorRegistry: !aggregator");
        reg.updateReputation(id, 1e16);
    }

    function test_UpdateReputation_EmitsReputationUpdated() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        uint256 expectedRep = 1e18 - 1e16;
        vm.expectEmit(true, false, false, true);
        emit SensorRegistry.ReputationUpdated(id, expectedRep, -1e16);
        vm.prank(aggregator);
        reg.updateReputation(id, -1e16);
    }

    // ── slashing ──────────────────────────────────────────────────────────────

    function test_Slash_FiresWhenBelowThreshold() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        // Drive reputation below SLASH_THRESHOLD (0.3e18) in one shot
        int256 delta = -(int256(1e18) - int256(reg.SLASH_THRESHOLD()) + 1e16);

        vm.expectEmit(true, false, false, false);
        emit SensorRegistry.Slashed(id, reg.SLASH_AMOUNT(), 0, false);
        vm.prank(aggregator);
        reg.updateReputation(id, delta);

        // Treasury receives SLASH_AMOUNT
        assertEq(usdc.balanceOf(treasury), reg.SLASH_AMOUNT());
    }

    function test_Slash_ReducesStake() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        int256 delta = -(int256(1e18) - int256(reg.SLASH_THRESHOLD()) + 1e16);
        vm.prank(aggregator);
        reg.updateReputation(id, delta);

        (,,,,,, uint256 stakeAmount,,, bool active) = _getSensor(id);
        assertEq(stakeAmount, reg.STAKE_REQUIRED() - reg.SLASH_AMOUNT());
        assertTrue(active); // 8 USDC remaining > MIN_STAKE_ACTIVE (4 USDC)
    }

    function test_Slash_AutoDeactivatesWhenStakeTooLow() public {
        vm.prank(operator1);
        uint256 id = reg.register("http://op1:3001", weatherTypes, 0, 0, 100);

        // Slash repeatedly until stake < MIN_STAKE_ACTIVE
        // Each slash: -2 USDC. Need 10 - 4 = 6 USDC slashed = 3 slashes to reach 4 USDC (still active)
        // 4th slash: 4 - 2 = 2 < 4 → deactivated
        int256 triggerDelta = -(int256(1e18) - int256(reg.SLASH_THRESHOLD()) + 1e16);

        for (uint256 i = 0; i < 4; i++) {
            if (i == 0) {
                vm.prank(aggregator);
                reg.updateReputation(id, triggerDelta);
            } else {
                vm.prank(aggregator);
                reg.updateReputation(id, -1e16); // keep below threshold
            }
        }

        (,,,,,, uint256 stakeAmount,,, bool active) = _getSensor(id);
        assertFalse(active);
        assertLt(stakeAmount, reg.MIN_STAKE_ACTIVE());
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _getSensor(uint256 id) internal view returns (
        address wallet,
        string memory endpointUrl,
        bytes32[] memory dataTypes,
        int256  lat,
        int256  lon,
        uint256 ratePerQuery,
        uint256 stakeAmount,
        uint256 reputation,
        uint256 totalQueries,
        bool    active
    ) {
        SensorRegistry.Sensor memory s = reg.getSensor(id);
        return (s.wallet, s.endpointUrl, s.dataTypes, s.lat, s.lon,
                s.ratePerQuery, s.stakeAmount, s.reputation, s.totalQueries, s.active);
    }
}
