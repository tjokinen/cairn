// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Registers sensor operators with stake and reputation.
/// Stake is held in this contract as USDC (ERC-20 interface at 0x3600...0000 on Arc).
/// Only the aggregator service may update reputation; slashing is automatic.
contract SensorRegistry is Ownable {
    using SafeERC20 for IERC20;

    // ── Types ─────────────────────────────────────────────────────────────────

    struct Sensor {
        address  wallet;
        string   endpointUrl;
        bytes32[] dataTypes;
        int256   lat;           // × 1e6
        int256   lon;           // × 1e6
        uint256  ratePerQuery;  // USDC (6 decimals)
        uint256  stakeAmount;   // USDC (6 decimals)
        uint256  reputation;    // 1e18 = 1.0, starts at 1e18
        uint256  totalQueries;
        bool     active;
    }

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant STAKE_REQUIRED   = 10 * 10 ** 6; // 10 USDC
    uint256 public constant SLASH_AMOUNT     =  2 * 10 ** 6; //  2 USDC per slash
    uint256 public constant SLASH_THRESHOLD  = 3e17;          // reputation < 0.3
    uint256 public constant MIN_STAKE_ACTIVE =  4 * 10 ** 6; //  4 USDC

    // ── State ─────────────────────────────────────────────────────────────────

    address public aggregatorService;
    address public treasury;
    IERC20  public usdc;

    mapping(uint256 => Sensor)    public sensors;
    mapping(bytes32 => uint256[]) private _sensorsByType;
    uint256 public sensorCount;

    // ── Events ────────────────────────────────────────────────────────────────

    event SensorRegistered(
        uint256 indexed sensorId,
        address indexed wallet,
        string  endpointUrl,
        bytes32[] dataTypes,
        int256  lat,
        int256  lon,
        uint256 ratePerQuery
    );
    event SensorDeactivated(uint256 indexed sensorId);
    event ReputationUpdated(uint256 indexed sensorId, uint256 newReputation, int256 delta);
    event Slashed(uint256 indexed sensorId, uint256 amount, uint256 remainingStake, bool autoDeactivated);

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyAggregator() {
        require(msg.sender == aggregatorService, "SensorRegistry: !aggregator");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _treasury, address _usdc) Ownable(msg.sender) {
        require(_treasury != address(0), "SensorRegistry: zero treasury");
        require(_usdc     != address(0), "SensorRegistry: zero usdc");
        treasury = _treasury;
        usdc     = IERC20(_usdc);
    }

    // ── Owner config ──────────────────────────────────────────────────────────

    function setAggregatorService(address _aggregatorService) external onlyOwner {
        require(_aggregatorService != address(0), "SensorRegistry: zero aggregator");
        aggregatorService = _aggregatorService;
    }

    // ── Operator actions ──────────────────────────────────────────────────────

    /// @notice Register a new sensor. Caller must have approved STAKE_REQUIRED USDC to this contract.
    function register(
        string   calldata endpointUrl,
        bytes32[] calldata dataTypes,
        int256   lat,
        int256   lon,
        uint256  ratePerQuery
    ) external returns (uint256 sensorId) {
        require(bytes(endpointUrl).length > 0, "SensorRegistry: empty endpoint");
        require(dataTypes.length > 0,          "SensorRegistry: no dataTypes");
        require(ratePerQuery > 0,              "SensorRegistry: zero rate");

        usdc.safeTransferFrom(msg.sender, address(this), STAKE_REQUIRED);

        sensorCount++;
        sensorId = sensorCount;

        bytes32[] memory dtCopy = new bytes32[](dataTypes.length);
        for (uint256 i = 0; i < dataTypes.length; i++) {
            dtCopy[i] = dataTypes[i];
            _sensorsByType[dataTypes[i]].push(sensorId);
        }

        sensors[sensorId] = Sensor({
            wallet:       msg.sender,
            endpointUrl:  endpointUrl,
            dataTypes:    dtCopy,
            lat:          lat,
            lon:          lon,
            ratePerQuery: ratePerQuery,
            stakeAmount:  STAKE_REQUIRED,
            reputation:   1e18,
            totalQueries: 0,
            active:       true
        });

        emit SensorRegistered(sensorId, msg.sender, endpointUrl, dtCopy, lat, lon, ratePerQuery);
    }

    /// @notice Deactivate own sensor and withdraw remaining stake.
    function deactivate(uint256 sensorId) external {
        Sensor storage s = sensors[sensorId];
        require(s.wallet == msg.sender, "SensorRegistry: not owner");
        require(s.active,               "SensorRegistry: already inactive");

        s.active = false;
        uint256 remaining = s.stakeAmount;
        s.stakeAmount = 0;

        if (remaining > 0) {
            usdc.safeTransfer(msg.sender, remaining);
        }

        emit SensorDeactivated(sensorId);
    }

    // ── Aggregator actions ────────────────────────────────────────────────────

    /// @notice Update a sensor's reputation. Triggers slashing if it falls below SLASH_THRESHOLD.
    function updateReputation(uint256 sensorId, int256 delta) external onlyAggregator {
        Sensor storage s = sensors[sensorId];
        require(s.wallet != address(0), "SensorRegistry: unknown sensor");

        int256 current = int256(s.reputation);
        int256 next    = current + delta;
        if (next < 0)          next = 0;
        if (next > int256(1e18)) next = int256(1e18);

        s.reputation = uint256(next);
        emit ReputationUpdated(sensorId, s.reputation, delta);

        if (s.reputation < SLASH_THRESHOLD && s.active) {
            _slash(sensorId);
        }
    }

    /// @notice Increment a sensor's query counter. Called by the aggregator on each paid query.
    function incrementQueryCount(uint256 sensorId) external onlyAggregator {
        sensors[sensorId].totalQueries++;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Returns all sensor IDs registered for a given data type (active and inactive).
    function getSensorsForType(bytes32 dataType) external view returns (uint256[] memory) {
        return _sensorsByType[dataType];
    }

    /// @notice Returns the full sensor struct including the dataTypes array.
    function getSensor(uint256 sensorId) external view returns (Sensor memory) {
        return sensors[sensorId];
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _slash(uint256 sensorId) internal {
        Sensor storage s = sensors[sensorId];
        uint256 amount = s.stakeAmount >= SLASH_AMOUNT ? SLASH_AMOUNT : s.stakeAmount;
        if (amount == 0) return;

        s.stakeAmount -= amount;
        usdc.safeTransfer(treasury, amount);

        bool autoDeactivated = s.stakeAmount < MIN_STAKE_ACTIVE;
        if (autoDeactivated) {
            s.active = false;
        }

        emit Slashed(sensorId, amount, s.stakeAmount, autoDeactivated);
    }
}
