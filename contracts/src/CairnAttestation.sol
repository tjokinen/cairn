// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Immutable on-chain record of every verification result produced by the aggregator.
contract CairnAttestation is Ownable {
    /// @dev `verifiedValue` is intentionally NOT stored on-chain. Storing it would let
    /// non-paying observers read paid data from the chain (`getAttestation`). Instead
    /// `payloadHash` cryptographically commits to the value + raw readings; the value
    /// itself is returned only to the paying customer via the aggregator API response.
    /// Smart contracts that need on-chain proof re-derive the hash from a customer-supplied
    /// (value, readings) tuple and compare against `payloadHash`.
    struct Attestation {
        bytes32   dataType;
        int256    lat;                  // × 1e6
        int256    lon;                  // × 1e6
        uint256   timestamp;
        uint256[] contributingSensors;
        uint256[] excludedSensors;
        uint256   confidenceBps;        // 0–10000
        bytes32   payloadHash;          // keccak256(verifiedValue || canonical readings + signatures)
    }

    address public aggregatorService;
    mapping(bytes32 => Attestation) private _attestations;

    event AttestationPosted(
        bytes32 indexed attestationId,
        bytes32 indexed dataType,
        int256          lat,
        int256          lon,
        uint256         timestamp,
        uint256         confidenceBps
    );

    modifier onlyAggregator() {
        require(msg.sender == aggregatorService, "CairnAttestation: !aggregator");
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setAggregatorService(address _aggregatorService) external onlyOwner {
        require(_aggregatorService != address(0), "CairnAttestation: zero aggregator");
        aggregatorService = _aggregatorService;
    }

    /// @notice Store a verification result. Returns deterministic attestationId = keccak256(abi.encode(a)).
    function postAttestation(Attestation calldata a) external onlyAggregator returns (bytes32 attestationId) {
        require(a.timestamp > 0,              "CairnAttestation: zero timestamp");
        require(a.confidenceBps <= 10_000,    "CairnAttestation: confidenceBps > 10000");

        attestationId = keccak256(abi.encode(a));
        require(_attestations[attestationId].timestamp == 0, "CairnAttestation: already exists");

        _attestations[attestationId] = a;

        emit AttestationPosted(
            attestationId,
            a.dataType,
            a.lat,
            a.lon,
            a.timestamp,
            a.confidenceBps
        );
    }

    function getAttestation(bytes32 attestationId) external view returns (Attestation memory) {
        return _attestations[attestationId];
    }
}
