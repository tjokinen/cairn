// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CairnAttestation.sol";

contract CairnAttestationTest is Test {
    CairnAttestation att;

    address aggregator = address(0x2222);

    function setUp() public {
        att = new CairnAttestation();
        att.setAggregatorService(aggregator);
    }

    function _makeAttestation() internal pure returns (CairnAttestation.Attestation memory a) {
        uint256[] memory contributing = new uint256[](2);
        contributing[0] = 1;
        contributing[1] = 3;

        uint256[] memory excluded = new uint256[](1);
        excluded[0] = 2;

        a = CairnAttestation.Attestation({
            dataType:            bytes32("weather.temperature_c"),
            lat:                  18_900_000,
            lon:                 -103_870_000,
            timestamp:            1_700_000_000,
            contributingSensors:  contributing,
            excludedSensors:      excluded,
            verifiedValue:        28_150_000, // 28.15 × 1e6
            confidenceBps:        7500,
            payloadHash:          keccak256("readings+sigs")
        });
    }

    // ── postAttestation ───────────────────────────────────────────────────────

    function test_PostAttestation_ReturnsDeterministicId() public {
        CairnAttestation.Attestation memory a = _makeAttestation();
        bytes32 expectedId = keccak256(abi.encode(a));

        vm.prank(aggregator);
        bytes32 id = att.postAttestation(a);

        assertEq(id, expectedId);
    }

    function test_PostAttestation_SameInputSameId() public {
        CairnAttestation.Attestation memory a = _makeAttestation();

        vm.prank(aggregator);
        bytes32 id1 = att.postAttestation(a);

        // Different timestamp so it's a new record
        a.timestamp = 1_700_000_001;
        vm.prank(aggregator);
        bytes32 id2 = att.postAttestation(a);

        assertNotEq(id1, id2);

        // Same data → same id
        bytes32 recalcId1 = keccak256(abi.encode(_makeAttestation()));
        assertEq(id1, recalcId1);
    }

    function test_PostAttestation_StoresData() public {
        CairnAttestation.Attestation memory a = _makeAttestation();

        vm.prank(aggregator);
        bytes32 id = att.postAttestation(a);

        CairnAttestation.Attestation memory stored = att.getAttestation(id);
        assertEq(stored.dataType,        a.dataType);
        assertEq(stored.lat,             a.lat);
        assertEq(stored.lon,             a.lon);
        assertEq(stored.timestamp,       a.timestamp);
        assertEq(stored.verifiedValue,   a.verifiedValue);
        assertEq(stored.confidenceBps,   a.confidenceBps);
        assertEq(stored.payloadHash,     a.payloadHash);
        assertEq(stored.contributingSensors.length, 2);
        assertEq(stored.excludedSensors.length,     1);
    }

    function test_PostAttestation_EmitsEvent() public {
        CairnAttestation.Attestation memory a = _makeAttestation();
        bytes32 expectedId = keccak256(abi.encode(a));

        vm.expectEmit(true, true, false, true);
        emit CairnAttestation.AttestationPosted(
            expectedId,
            a.dataType,
            a.lat,
            a.lon,
            a.timestamp,
            a.confidenceBps
        );

        vm.prank(aggregator);
        att.postAttestation(a);
    }

    function test_PostAttestation_RevertsOnDuplicate() public {
        CairnAttestation.Attestation memory a = _makeAttestation();

        vm.prank(aggregator);
        att.postAttestation(a);

        vm.prank(aggregator);
        vm.expectRevert("CairnAttestation: already exists");
        att.postAttestation(a);
    }

    function test_PostAttestation_RevertsIfNotAggregator() public {
        vm.expectRevert("CairnAttestation: !aggregator");
        att.postAttestation(_makeAttestation());
    }

    function test_PostAttestation_RevertsOnZeroTimestamp() public {
        CairnAttestation.Attestation memory a = _makeAttestation();
        a.timestamp = 0;

        vm.prank(aggregator);
        vm.expectRevert("CairnAttestation: zero timestamp");
        att.postAttestation(a);
    }

    function test_PostAttestation_RevertsOnInvalidConfidence() public {
        CairnAttestation.Attestation memory a = _makeAttestation();
        a.confidenceBps = 10_001;

        vm.prank(aggregator);
        vm.expectRevert("CairnAttestation: confidenceBps > 10000");
        att.postAttestation(a);
    }

    // ── getAttestation ────────────────────────────────────────────────────────

    function test_GetAttestation_ReturnsEmptyForUnknownId() public view {
        CairnAttestation.Attestation memory a = att.getAttestation(bytes32(0));
        assertEq(a.timestamp, 0);
    }
}
