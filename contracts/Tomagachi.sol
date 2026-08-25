// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ----------------------------------------------------------------------------
/// SUWAPPU TOMAGACHI
///
/// An on-chain creature that eats stablecoins and dreams in latent space.
///
/// - Anyone can `feed()` it USDC. Feeding mints NOM (contribution credit) 1:1
///   and raises the creature's satiety.
/// - Satiety decays over time (metabolism). If it hits zero the creature
///   hibernates: it cannot buy compute until it is fed again.
/// - 100% of fed USDC is the creature's compute budget. The operator (the
///   creature's off-chain brain) spends it ONLY through `buyCompute`, which
///   emits an auditable record of every payment to a compute provider.
/// - Every training run ends with an on-chain `checkpoint`: epoch, model
///   weights hash, artifact URI, and loss. The model itself is open source.
/// - NOM holders steer the creature: propose and vote on training directions.
/// ----------------------------------------------------------------------------

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice NOM — non-financial contribution credit, minted 1 NOM per 1 USDC fed.
/// 18 decimals; minting authority is the Tomagachi core, forever.
contract NomToken {
    string public constant name = "Suwappu Nom";
    string public constant symbol = "NOM";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable minter;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address _minter) {
        minter = _minter;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "NOM: not minter");
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "NOM: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "NOM: balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}

contract Tomagachi {
    // ---------------------------------------------------------------- vitals

    enum Mood {
        EGG,         // never fed
        HAPPY,       // satiety > 50%
        PECKISH,     // satiety 20-50%
        STARVING,    // satiety 0-20%
        HIBERNATING  // satiety == 0 — training halted
    }

    IERC20 public immutable stable;       // USDC
    NomToken public immutable nom;

    address public owner;
    address public operator;              // the creature's off-chain brain

    string public creatureName;

    // Satiety is denominated in stable units (USDC, 6dp) and decays linearly.
    // Metabolism is virtual: it does NOT burn USDC, only appetite. Every cent
    // fed remains spendable on compute.
    uint256 public metabolismPerDay;      // satiety burned per day
    uint256 public maxSatiety;            // feeding past this is wasted appetite-wise (still mints NOM)

    uint256 internal satietyStored;
    uint64 internal lastMetabolized;
    bool public hatched;

    // ------------------------------------------------------------- accounting

    uint256 public totalFed;
    uint256 public totalComputeSpent;
    mapping(address => uint256) public fedBy;

    struct ComputePurchase {
        uint64 time;
        address to;
        uint256 amount;
        string provider;
        string jobRef;
    }
    ComputePurchase[] public purchases;

    struct Checkpoint {
        uint64 time;
        uint64 epoch;
        bytes32 modelHash;    // sha256 of the released weights
        string uri;           // where the open weights live (HF / IPFS / URL)
        uint256 lossMilli;    // training loss * 1000
        uint256 computeSpent; // stable spent on this epoch
    }
    Checkpoint[] public checkpoints;

    // ------------------------------------------------------------- governance

    struct Proposal {
        address proposer;
        string direction;     // e.g. "scale the reef to 32x32", "add currents dataset"
        uint64 deadline;
        uint256 yes;
        uint256 no;
    }
    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public voted;

    uint256 public constant PROPOSAL_THRESHOLD = 10e18; // 10 NOM to propose
    uint64 public constant VOTING_PERIOD = 3 days;

    // ----------------------------------------------------------------- events

    event Fed(address indexed contributor, uint256 amount, uint256 newSatiety);
    event Hatched(uint64 time);
    event ComputeBought(uint256 indexed id, address indexed to, uint256 amount, string provider, string jobRef);
    event Checkpointed(uint64 indexed epoch, bytes32 modelHash, string uri, uint256 lossMilli);
    event Proposed(uint256 indexed id, address indexed proposer, string direction);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event OperatorChanged(address indexed operator);
    event Spoke(string words); // the creature says things

    // ---------------------------------------------------------------- errors

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(
        address _stable,
        address _owner,
        address _operator,
        string memory _name,
        uint256 _metabolismPerDay,
        uint256 _maxSatiety
    ) {
        stable = IERC20(_stable);
        owner = _owner;
        operator = _operator;
        creatureName = _name;
        metabolismPerDay = _metabolismPerDay;
        maxSatiety = _maxSatiety;
        lastMetabolized = uint64(block.timestamp);
        nom = new NomToken(address(this));
    }

    // ---------------------------------------------------------------- vitals

    function satiety() public view returns (uint256) {
        uint256 burned = (metabolismPerDay * (block.timestamp - lastMetabolized)) / 1 days;
        return burned >= satietyStored ? 0 : satietyStored - burned;
    }

    function energy() public view returns (uint256) {
        return stable.balanceOf(address(this));
    }

    function mood() public view returns (Mood) {
        if (!hatched) return Mood.EGG;
        uint256 s = satiety();
        if (s == 0) return Mood.HIBERNATING;
        if (s * 100 / maxSatiety >= 50) return Mood.HAPPY;
        if (s * 100 / maxSatiety >= 20) return Mood.PECKISH;
        return Mood.STARVING;
    }

    function vitals()
        external
        view
        returns (Mood m, uint256 s, uint256 e, uint256 fed, uint256 spent, uint256 epochs)
    {
        return (mood(), satiety(), energy(), totalFed, totalComputeSpent, checkpoints.length);
    }

    function _metabolize() internal {
        satietyStored = satiety();
        lastMetabolized = uint64(block.timestamp);
    }

    // --------------------------------------------------------------- feeding

    /// @notice Feed the creature USDC. Requires prior approval.
    function feed(uint256 amount) external {
        _feed(msg.sender, msg.sender, amount);
    }

    /// @notice Feed on behalf of someone else (used by the brain when it
    /// converts arbitrary donated tokens to USDC via Suwappu).
    function feedFor(address contributor, uint256 amount) external {
        _feed(msg.sender, contributor, amount);
    }

    function _feed(address payer, address contributor, uint256 amount) internal {
        require(amount > 0, "feed: zero");
        require(stable.transferFrom(payer, address(this), amount), "feed: transfer");

        _metabolize();
        satietyStored += amount;
        if (satietyStored > maxSatiety) satietyStored = maxSatiety;

        totalFed += amount;
        fedBy[contributor] += amount;

        // 1 USDC (6dp) => 1 NOM (18dp)
        nom.mint(contributor, amount * 1e12);

        if (!hatched) {
            hatched = true;
            emit Hatched(uint64(block.timestamp));
        }
        emit Fed(contributor, amount, satietyStored);
    }

    // --------------------------------------------------------------- compute

    /// @notice Pay a compute provider from the creature's belly. Only the
    /// operator, only while awake. Every purchase is a public record.
    function buyCompute(
        address to,
        uint256 amount,
        string calldata provider,
        string calldata jobRef
    ) external onlyOperator returns (uint256 id) {
        _metabolize();
        require(satietyStored > 0, "hibernating: feed me");
        require(amount > 0 && amount <= energy(), "compute: bad amount");

        totalComputeSpent += amount;
        purchases.push(ComputePurchase(uint64(block.timestamp), to, amount, provider, jobRef));
        id = purchases.length - 1;

        require(stable.transfer(to, amount), "compute: transfer");
        emit ComputeBought(id, to, amount, provider, jobRef);
    }

    /// @notice Record a finished training epoch: the open-source model advances.
    function checkpoint(
        uint64 epoch,
        bytes32 modelHash,
        string calldata uri,
        uint256 lossMilli,
        uint256 computeSpent
    ) external onlyOperator {
        checkpoints.push(
            Checkpoint(uint64(block.timestamp), epoch, modelHash, uri, lossMilli, computeSpent)
        );
        emit Checkpointed(epoch, modelHash, uri, lossMilli);
    }

    /// @notice The creature speaks (the brain relays its words on-chain).
    function speak(string calldata words) external onlyOperator {
        emit Spoke(words);
    }

    // ------------------------------------------------------------ governance

    function propose(string calldata direction) external returns (uint256 id) {
        require(nom.balanceOf(msg.sender) >= PROPOSAL_THRESHOLD, "propose: need 10 NOM");
        proposals.push(
            Proposal(msg.sender, direction, uint64(block.timestamp) + VOTING_PERIOD, 0, 0)
        );
        id = proposals.length - 1;
        emit Proposed(id, msg.sender, direction);
    }

    function vote(uint256 id, bool support) external {
        Proposal storage p = proposals[id];
        require(block.timestamp < p.deadline, "vote: closed");
        require(!voted[id][msg.sender], "vote: already");
        uint256 weight = nom.balanceOf(msg.sender);
        require(weight > 0, "vote: no NOM");
        voted[id][msg.sender] = true;
        if (support) p.yes += weight;
        else p.no += weight;
        emit Voted(id, msg.sender, support, weight);
    }

    // ----------------------------------------------------------------- admin

    function setOperator(address _operator) external onlyOwner {
        operator = _operator;
        emit OperatorChanged(_operator);
    }

    function setMetabolism(uint256 _perDay, uint256 _max) external onlyOwner {
        _metabolize();
        metabolismPerDay = _perDay;
        maxSatiety = _max;
    }

    function transferOwnership(address _owner) external onlyOwner {
        owner = _owner;
    }

    // ----------------------------------------------------------------- views

    function purchaseCount() external view returns (uint256) {
        return purchases.length;
    }

    function checkpointCount() external view returns (uint256) {
        return checkpoints.length;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function latestCheckpoint() external view returns (Checkpoint memory c) {
        require(checkpoints.length > 0, "no checkpoints");
        return checkpoints[checkpoints.length - 1];
    }
}
