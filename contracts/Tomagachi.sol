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
/// - Idle USDC is farmed: the operator parks it in owner-whitelisted ERC-4626
///   vaults (money markets, tokenized T-bills, RWA vaults) and harvests the
///   real yield as food. Principal stays recallable compute budget; yield
///   raises satiety and mints no NOM — the creature earns its own keep.
/// - Revenue the shop earns (x402 pay-per-call inference) is eaten through
///   `earn()`: satiety up, zero NOM — customers are not contributors.
/// - NOM holders steer the creature: propose and vote on training directions.
/// ----------------------------------------------------------------------------

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice The slice of ERC-4626 the creature needs to farm its idle USDC.
/// Any standard vault qualifies: money markets (Aave/Morpho/Moonwell wrappers),
/// tokenized T-bill funds, RWA/tokenized-equity vaults — as long as it is
/// USDC-denominated and 4626-shaped, the owner can whitelist it.
interface IERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256);
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

    // Historical balance checkpoints, one per account, so governance can read
    // a voter's balance as of a fixed point in time (the proposal's snapshot)
    // instead of their live, transferable balance. Without this, one holder
    // could vote, transfer the same NOM to a second address, and vote again
    // with it, or mint fresh NOM mid-proposal and vote with it immediately.
    struct Checkpoint {
        uint64 time;
        uint256 balance;
    }
    mapping(address => Checkpoint[]) private checkpoints;

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
        _writeCheckpoint(to);
        emit Transfer(address(0), to, amount);
    }

    function _writeCheckpoint(address account) internal {
        uint256 n = checkpoints[account].length;
        if (n > 0 && checkpoints[account][n - 1].time == block.timestamp) {
            checkpoints[account][n - 1].balance = balanceOf[account];
        } else {
            checkpoints[account].push(Checkpoint(uint64(block.timestamp), balanceOf[account]));
        }
    }

    /// @notice Account's NOM balance at (or immediately before) `timestamp`.
    function getPastBalance(address account, uint64 timestamp) external view returns (uint256) {
        Checkpoint[] storage ckpts = checkpoints[account];
        uint256 n = ckpts.length;
        if (n == 0 || ckpts[0].time > timestamp) return 0;
        if (ckpts[n - 1].time <= timestamp) return ckpts[n - 1].balance;
        uint256 lo = 0;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (ckpts[mid].time <= timestamp) lo = mid;
            else hi = mid - 1;
        }
        return ckpts[lo].balance;
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
        _writeCheckpoint(from);
        _writeCheckpoint(to);
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
    uint256 public totalRevenueEarned;    // lifetime inference revenue eaten via earn()
    mapping(address => uint256) public fedBy;
    address[] public feeders;             // every unique contributor, in order of first feed
    string public lastWords;              // the creature's most recent speech

    struct ComputePurchase {
        uint64 time;
        address to;
        uint256 amount;
        string provider;
        string jobRef;
    }
    ComputePurchase[] public purchases;

    // -------------------------------------------------------------- treasury
    //
    // Real yield: idle USDC does not sit in the belly losing time value — the
    // operator parks it in owner-whitelisted ERC-4626 vaults. Principal stays
    // the creature's compute budget (recall it any time with divest); anything
    // the vault earns ABOVE principal is harvested as food the creature earned
    // for itself. Harvested yield raises satiety and mints no NOM: nobody
    // contributed it, the creature farmed it.

    mapping(address => bool) public allowedVault;
    mapping(address => bool) internal listedVault;  // ever pushed to vaultList
    mapping(address => uint256) public principalOf; // USDC principal per vault
    address[] public vaultList;                     // every vault ever whitelisted
    uint256 public totalInvested;                   // sum of live principals
    uint256 public totalYieldEarned;                // lifetime harvested yield

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
        uint64 deadline;
        string direction;     // e.g. "scale the reef to 32x32", "add currents dataset"
        uint256 yes;
        uint256 no;
        uint64 snapshotTime;  // NOM balances are weighed as of this moment, not live
    }
    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public voted;

    uint256 public constant PROPOSAL_THRESHOLD = 10e18; // 10 NOM to propose
    uint64 public constant VOTING_PERIOD = 3 days;

    // ----------------------------------------------------------------- events

    event Fed(address indexed contributor, uint256 amount, uint256 newSatiety);
    event VaultAllowed(address indexed vault, bool allowed);
    event Invested(address indexed vault, uint256 amount);
    event Divested(address indexed vault, uint256 amount);
    event Harvested(address indexed vault, uint256 yieldAmount, uint256 newSatiety);
    event Earned(string source, uint256 amount, uint256 newSatiety);
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

    // Reentrancy guard for every external function that hands control to an
    // owner-whitelisted (but not necessarily trustworthy) ERC-4626 vault, or
    // to the stable token, before it is done updating state.
    uint256 private _locked = 1;

    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
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
    function feed(uint256 amount) external nonReentrant {
        _feed(msg.sender, msg.sender, amount);
    }

    /// @notice Feed on behalf of someone else (used by the brain when it
    /// converts arbitrary donated tokens to USDC via Suwappu).
    function feedFor(address contributor, uint256 amount) external nonReentrant {
        _feed(msg.sender, contributor, amount);
    }

    function _feed(address payer, address contributor, uint256 amount) internal {
        require(amount > 0, "feed: zero");
        require(stable.transferFrom(payer, address(this), amount), "feed: transfer");

        _metabolize();
        satietyStored += amount;
        if (satietyStored > maxSatiety) satietyStored = maxSatiety;

        totalFed += amount;
        if (fedBy[contributor] == 0) feeders.push(contributor);
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
    ) external onlyOperator nonReentrant returns (uint256 id) {
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
        require(
            checkpoints.length == 0 || epoch > checkpoints[checkpoints.length - 1].epoch,
            "checkpoint: epoch must increase"
        );
        checkpoints.push(
            Checkpoint(uint64(block.timestamp), epoch, modelHash, uri, lossMilli, computeSpent)
        );
        emit Checkpointed(epoch, modelHash, uri, lossMilli);
    }

    /// @notice The creature speaks (the brain relays its words on-chain).
    function speak(string calldata words) external onlyOperator {
        lastWords = words;
        emit Spoke(words);
    }

    /// @notice Eat what the creature earned: inference revenue (x402 pay-per-
    /// call, invoiced routing) settled to the operating wallet and passed in.
    /// Like harvest, earnings raise satiety and mint NO NOM — customers are
    /// not contributors, and NOM stays strictly non-revenue-bearing.
    function earn(uint256 amount, string calldata source) external onlyOperator nonReentrant {
        require(amount > 0, "earn: zero");
        require(stable.transferFrom(msg.sender, address(this), amount), "earn: transfer");

        totalRevenueEarned += amount;
        _metabolize();
        satietyStored += amount;
        if (satietyStored > maxSatiety) satietyStored = maxSatiety;
        emit Earned(source, amount, satietyStored);
    }

    // -------------------------------------------------------------- treasury

    /// @notice Whitelist (or delist) a USDC-denominated ERC-4626 vault the
    /// operator may farm. Delisting blocks new deposits; existing positions
    /// can always be divested and harvested.
    function allowVault(address vault, bool allowed) external onlyOwner {
        if (allowed) {
            require(IERC4626(vault).asset() == address(stable), "vault: wrong asset");
            if (!listedVault[vault]) {
                listedVault[vault] = true;
                vaultList.push(vault);
            }
        }
        allowedVault[vault] = allowed;
        emit VaultAllowed(vault, allowed);
    }

    /// @notice Park idle USDC in a whitelisted vault. Not spending — principal
    /// stays the creature's and is recallable via `divest` at any time — so
    /// unlike `buyCompute` this works even while hibernating.
    function invest(address vault, uint256 amount) external onlyOperator nonReentrant {
        require(allowedVault[vault], "invest: vault not allowed");
        require(amount > 0 && amount <= stable.balanceOf(address(this)), "invest: bad amount");

        principalOf[vault] += amount;
        totalInvested += amount;

        require(stable.approve(vault, amount), "invest: approve");
        IERC4626(vault).deposit(amount, address(this));
        emit Invested(vault, amount);
    }

    /// @notice Recall principal from a vault back into liquid compute budget.
    /// Harvest first if there is pending yield, so it is counted as earnings
    /// rather than blended silently into principal.
    function divest(address vault, uint256 amount) external onlyOperator nonReentrant {
        uint256 p = principalOf[vault];
        require(amount > 0 && amount <= p, "divest: bad amount");

        principalOf[vault] = p - amount;
        totalInvested -= amount;

        IERC4626(vault).withdraw(amount, address(this), address(this));
        emit Divested(vault, amount);
    }

    /// @notice Withdraw everything a vault has earned above principal. The
    /// yield lands as liquid USDC (more compute budget) AND counts as food:
    /// satiety rises, no NOM is minted — the creature earned this itself.
    function harvest(address vault) external onlyOperator nonReentrant returns (uint256 yieldAmount) {
        uint256 value = IERC4626(vault).convertToAssets(IERC4626(vault).balanceOf(address(this)));
        uint256 p = principalOf[vault];
        require(value > p, "harvest: nothing to harvest");
        yieldAmount = value - p;

        // Effects before interaction: every state change this call makes is
        // committed before the external withdraw() call, so a reentrant call
        // back into the contract (from a malicious or compromised vault)
        // observes fully up-to-date satiety/energy accounting rather than a
        // stale, pre-harvest snapshot.
        totalYieldEarned += yieldAmount;
        _metabolize();
        satietyStored += yieldAmount;
        if (satietyStored > maxSatiety) satietyStored = maxSatiety;

        IERC4626(vault).withdraw(yieldAmount, address(this), address(this));

        emit Harvested(vault, yieldAmount, satietyStored);
    }

    /// @notice Current value of every vault position, marked by the vaults.
    function investedAssets() public view returns (uint256 total) {
        for (uint256 i = 0; i < vaultList.length; i++) {
            IERC4626 v = IERC4626(vaultList[i]);
            // A single broken vault (paused, self-destructed, or otherwise
            // reverting on these view calls) must not brick the aggregate
            // read for every other vault's position.
            try v.balanceOf(address(this)) returns (uint256 shares) {
                if (shares > 0) {
                    try v.convertToAssets(shares) returns (uint256 assets) {
                        total += assets;
                    } catch {}
                }
            } catch {}
        }
    }

    /// @notice The whole balance sheet in one read: liquid compute budget,
    /// invested value, principal at risk, and lifetime harvested yield.
    function treasury()
        external
        view
        returns (uint256 liquid, uint256 invested, uint256 principal, uint256 yieldEarned)
    {
        return (energy(), investedAssets(), totalInvested, totalYieldEarned);
    }

    // ------------------------------------------------------------ governance

    function propose(string calldata direction) external returns (uint256 id) {
        require(nom.balanceOf(msg.sender) >= PROPOSAL_THRESHOLD, "propose: need 10 NOM");
        proposals.push(
            Proposal(
                msg.sender,
                uint64(block.timestamp) + VOTING_PERIOD,
                direction,
                0,
                0,
                uint64(block.timestamp)
            )
        );
        id = proposals.length - 1;
        emit Proposed(id, msg.sender, direction);
    }

    /// @notice Vote weight is the voter's NOM balance at proposal creation
    /// time (`p.snapshotTime`), not their live balance — otherwise a single
    /// holder could vote, transfer the same NOM to a second address, and
    /// vote again with it, or feed USDC mid-vote to mint fresh NOM and use
    /// it immediately.
    function vote(uint256 id, bool support) external {
        Proposal storage p = proposals[id];
        require(block.timestamp < p.deadline, "vote: closed");
        require(!voted[id][msg.sender], "vote: already");
        uint256 weight = nom.getPastBalance(msg.sender, p.snapshotTime);
        require(weight > 0, "vote: no NOM");
        voted[id][msg.sender] = true;
        if (support) p.yes += weight;
        else p.no += weight;
        emit Voted(id, msg.sender, support, weight);
    }

    // ----------------------------------------------------------------- admin

    function setOperator(address _operator) external onlyOwner {
        require(_operator != address(0), "operator: zero");
        operator = _operator;
        emit OperatorChanged(_operator);
    }

    function setMetabolism(uint256 _perDay, uint256 _max) external onlyOwner {
        _metabolize();
        metabolismPerDay = _perDay;
        maxSatiety = _max;
    }

    function transferOwnership(address _owner) external onlyOwner {
        require(_owner != address(0), "owner: zero");
        owner = _owner;
    }

    // ----------------------------------------------------------------- views

    function purchaseCount() external view returns (uint256) {
        return purchases.length;
    }

    function vaultCount() external view returns (uint256) {
        return vaultList.length;
    }

    function feederCount() external view returns (uint256) {
        return feeders.length;
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
