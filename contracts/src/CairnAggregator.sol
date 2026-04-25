// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Pure event-emitter for on-chain audit of every query's payment accounting.
/// Does not move USDC — all payments are settled off-chain via Circle Nanopayments.
contract CairnAggregator is Ownable {
    address public treasury;
    address public aggregatorService;

    event OperatorPaid(
        address indexed customer,
        uint256 indexed sensorId,
        address         sensorWallet,
        uint256         amount,
        bytes32 indexed queryId
    );

    event ProtocolFeeCollected(
        address indexed customer,
        uint256         amount,
        bytes32 indexed queryId
    );

    modifier onlyAggregator() {
        require(msg.sender == aggregatorService, "CairnAggregator: !aggregator");
        _;
    }

    constructor(address _treasury) Ownable(msg.sender) {
        require(_treasury != address(0), "CairnAggregator: zero treasury");
        treasury = _treasury;
    }

    function setAggregatorService(address _aggregatorService) external onlyOwner {
        require(_aggregatorService != address(0), "CairnAggregator: zero aggregator");
        aggregatorService = _aggregatorService;
    }

    /// @notice Record a completed query. Emits N OperatorPaid + 1 ProtocolFeeCollected.
    function recordQuery(
        address          customer,
        uint256[] calldata sensorIds,
        address[] calldata sensorWallets,
        uint256[] calldata operatorAmounts,
        uint256          protocolFeeAmount,
        bytes32          queryId
    ) external onlyAggregator {
        require(
            sensorIds.length == sensorWallets.length &&
            sensorIds.length == operatorAmounts.length,
            "CairnAggregator: array length mismatch"
        );
        require(sensorIds.length > 0, "CairnAggregator: no sensors");

        for (uint256 i = 0; i < sensorIds.length; i++) {
            emit OperatorPaid(customer, sensorIds[i], sensorWallets[i], operatorAmounts[i], queryId);
        }

        emit ProtocolFeeCollected(customer, protocolFeeAmount, queryId);
    }
}
