// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CairnAggregator.sol";

contract CairnAggregatorTest is Test {
    CairnAggregator agg;

    address treasury   = address(0x1111);
    address aggregator = address(0x2222);
    address customer   = address(0x3333);

    bytes32 constant QUERY_ID = keccak256("query-001");

    uint256[] sensorIds;
    address[] sensorWallets;
    uint256[] amounts;

    function setUp() public {
        agg = new CairnAggregator(treasury);
        agg.setAggregatorService(aggregator);

        sensorIds     = new uint256[](3);
        sensorWallets = new address[](3);
        amounts       = new uint256[](3);

        sensorIds[0] = 1; sensorWallets[0] = address(0xA1); amounts[0] = 100;
        sensorIds[1] = 2; sensorWallets[1] = address(0xA2); amounts[1] = 200;
        sensorIds[2] = 3; sensorWallets[2] = address(0xA3); amounts[2] = 240;
    }

    // ── recordQuery ───────────────────────────────────────────────────────────

    function test_RecordQuery_EmitsNOperatorPaid() public {
        vm.expectEmit(true, true, false, true);
        emit CairnAggregator.OperatorPaid(customer, 1, address(0xA1), 100, QUERY_ID);
        vm.expectEmit(true, true, false, true);
        emit CairnAggregator.OperatorPaid(customer, 2, address(0xA2), 200, QUERY_ID);
        vm.expectEmit(true, true, false, true);
        emit CairnAggregator.OperatorPaid(customer, 3, address(0xA3), 240, QUERY_ID);

        vm.prank(aggregator);
        agg.recordQuery(customer, sensorIds, sensorWallets, amounts, 11, QUERY_ID);
    }

    function test_RecordQuery_EmitsProtocolFeeCollected() public {
        vm.expectEmit(true, false, true, true);
        emit CairnAggregator.ProtocolFeeCollected(customer, 11, QUERY_ID);

        vm.prank(aggregator);
        agg.recordQuery(customer, sensorIds, sensorWallets, amounts, 11, QUERY_ID);
    }

    function test_RecordQuery_TotalEventCount() public {
        // 3 OperatorPaid + 1 ProtocolFeeCollected = 4 events
        vm.recordLogs();
        vm.prank(aggregator);
        agg.recordQuery(customer, sensorIds, sensorWallets, amounts, 11, QUERY_ID);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 4);
    }

    function test_RecordQuery_SingleSensor_TwoEvents() public {
        uint256[] memory ids   = new uint256[](1);
        address[] memory walls = new address[](1);
        uint256[] memory amts  = new uint256[](1);
        ids[0] = 1; walls[0] = address(0xA1); amts[0] = 100;

        vm.recordLogs();
        vm.prank(aggregator);
        agg.recordQuery(customer, ids, walls, amts, 2, QUERY_ID);

        assertEq(vm.getRecordedLogs().length, 2); // 1 OperatorPaid + 1 ProtocolFeeCollected
    }

    function test_RecordQuery_RevertsIfNotAggregator() public {
        vm.prank(customer);
        vm.expectRevert("CairnAggregator: !aggregator");
        agg.recordQuery(customer, sensorIds, sensorWallets, amounts, 11, QUERY_ID);
    }

    function test_RecordQuery_RevertsOnLengthMismatch() public {
        uint256[] memory shortIds = new uint256[](2);
        shortIds[0] = 1; shortIds[1] = 2;

        vm.prank(aggregator);
        vm.expectRevert("CairnAggregator: array length mismatch");
        agg.recordQuery(customer, shortIds, sensorWallets, amounts, 11, QUERY_ID);
    }

    function test_RecordQuery_RevertsOnEmptySensors() public {
        uint256[] memory empty = new uint256[](0);

        vm.prank(aggregator);
        vm.expectRevert("CairnAggregator: no sensors");
        agg.recordQuery(customer, empty, new address[](0), new uint256[](0), 0, QUERY_ID);
    }

    // ── config ────────────────────────────────────────────────────────────────

    function test_SetAggregatorService_RevertsIfNotOwner() public {
        vm.prank(customer);
        vm.expectRevert();
        agg.setAggregatorService(address(0xDEAD));
    }
}
