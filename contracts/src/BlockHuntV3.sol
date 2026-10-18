// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * BlockHunt V3 — anti-cheat tournament contract (Avalanche C-Chain)
 *
 * What changed from V2
 *  - Scores must carry a signature from the BlockHunt score server. The server
 *    times every attempt itself and checks every found word, so nobody can
 *    send a made-up time straight to the contract.
 *  - One paid entry = one scored attempt. Pay again to try again; best time counts.
 *  - Same payout rule for every mode: house cut first, then 70 / 20 / 10 to the
 *    top 3. Empty places go to 1st. No finished scores at all -> the whole pool
 *    rolls into the current round of that mode (house never keeps it).
 *  - Real on-chain referrals: a referrer earns 2% of every entry their friend
 *    makes, paid out of the house cut (players' prize pool is untouched).
 *  - Rounds are fixed calendar periods (daily UTC / weekly Sun 00:00 UTC), so a
 *    missed settlement never freezes the game. Anyone can settle a finished round.
 *  - Winners are paid automatically; if a payment bounces it waits as a claim.
 *  - Top 3 is tracked live, so settlement cost never grows with player count.
 */
contract BlockHuntV3 {
    // ─────────────────────────────── constants ───────────────────────────────
    uint8 public constant EASY = 0;
    uint8 public constant HARD = 1;
    uint8 public constant WEEKLY = 2;

    uint256 public constant FEE_EASY = 0.05 ether;
    uint256 public constant FEE_HARD = 0.085 ether;
    uint256 public constant FEE_WEEKLY = 0.1 ether;

    uint256 public constant HOUSE_BPS_DAILY = 500; //  5% Easy / Hard
    uint256 public constant HOUSE_BPS_WEEKLY = 1000; // 10% Weekly
    uint256 public constant REF_BPS = 200; //  2% of entry, paid from the house cut
    uint256 public constant FIRST_BPS = 7000;
    uint256 public constant SECOND_BPS = 2000; // 3rd gets the rest (10%)

    uint256 public constant ROUND_TIME_MS = 120_000; // a game lasts 2 minutes
    uint256 public constant GRACE = 10 minutes; // finish a game that started before midnight
    uint256 public constant PAY_GAS = 50_000;

    bytes32 public constant SCORE_TYPEHASH = keccak256("BlockHuntScore(v3)");

    // ─────────────────────────────── storage ─────────────────────────────────
    struct Round {
        uint128 pool;
        uint32 entries;
        uint32 players;
        bool settled;
        address[3] top;
        uint32[3] topMs;
    }

    struct PlayerRound {
        uint16 entries; // paid entries this round
        uint16 attempts; // signed attempts used (each entry = one attempt)
        uint32 bestMs; // 0 = no finished game yet
    }

    address public immutable house;
    address public owner;
    address public signer;
    bool public paused;

    mapping(uint8 => mapping(uint256 => Round)) internal _rounds;
    mapping(uint8 => mapping(uint256 => mapping(address => PlayerRound))) internal _players;
    mapping(address => address) public referrerOf;
    mapping(address => uint256) public claimable;

    uint256 private _lock = 1;

    // ─────────────────────────────── events ──────────────────────────────────
    event Entered(uint8 indexed mode, uint256 indexed roundId, address indexed player, address referrer, uint256 pool);
    event Scored(uint8 indexed mode, uint256 indexed roundId, address indexed player, uint256 timeMs, bool newBest);
    event Settled(
        uint8 indexed mode,
        uint256 indexed roundId,
        address first,
        address second,
        address third,
        uint256 firstPaid,
        uint256 secondPaid,
        uint256 thirdPaid
    );
    event RolledOver(uint8 indexed mode, uint256 indexed fromRound, uint256 indexed toRound, uint256 amount);
    event Credited(address indexed to, uint256 amount, string reason);
    event Claimed(address indexed to, uint256 amount);
    event SignerChanged(address signer);
    event OwnerChanged(address owner);
    event Paused(bool paused);

    // ─────────────────────────────── modifiers ───────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "Busy");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier validMode(uint8 mode) {
        require(mode <= WEEKLY, "Bad mode");
        _;
    }

    constructor(address _house, address _signer) {
        require(_house != address(0) && _signer != address(0), "Zero address");
        house = _house;
        owner = _house;
        signer = _signer;
    }

    // ─────────────────────────────── rounds & time ───────────────────────────
    function feeOf(uint8 mode) public pure validMode(mode) returns (uint256) {
        if (mode == EASY) return FEE_EASY;
        if (mode == HARD) return FEE_HARD;
        return FEE_WEEKLY;
    }

    /// Daily rounds: UTC day number. Weekly rounds: weeks starting Sunday 00:00 UTC.
    function roundIdAt(uint8 mode, uint256 timestamp) public pure validMode(mode) returns (uint256) {
        uint256 day = timestamp / 1 days;
        return mode == WEEKLY ? (day + 4) / 7 : day;
    }

    function currentRound(uint8 mode) public view returns (uint256) {
        return roundIdAt(mode, block.timestamp);
    }

    function roundEnd(uint8 mode, uint256 roundId) public pure validMode(mode) returns (uint256) {
        return mode == WEEKLY ? ((roundId + 1) * 7 - 4) * 1 days : (roundId + 1) * 1 days;
    }

    // ─────────────────────────────── entering ────────────────────────────────
    /// Pay the entry fee for the current round. `referrer` is only recorded the
    /// first time this wallet ever enters (pass address(0) for none).
    function enter(uint8 mode, address referrer) external payable validMode(mode) nonReentrant {
        require(!paused, "Entries paused");
        uint256 fee = feeOf(mode);
        require(msg.value == fee, "Wrong fee");

        uint256 roundId = currentRound(mode);
        Round storage r = _rounds[mode][roundId];
        PlayerRound storage p = _players[mode][roundId][msg.sender];
        require(p.entries < type(uint16).max, "Too many entries");

        // House cut, part of which may go to a referrer
        uint256 houseCut = fee * (mode == WEEKLY ? HOUSE_BPS_WEEKLY : HOUSE_BPS_DAILY) / 10_000;
        address ref = referrerOf[msg.sender];
        if (ref == address(0) && referrer != address(0) && referrer != msg.sender) {
            referrerOf[msg.sender] = referrer;
            ref = referrer;
        }
        if (ref != address(0)) {
            uint256 refCut = fee * REF_BPS / 10_000;
            houseCut -= refCut;
            claimable[ref] += refCut;
            emit Credited(ref, refCut, "referral");
        }
        claimable[house] += houseCut;
        emit Credited(house, houseCut, "house");

        uint256 toPool = fee - (fee * (mode == WEEKLY ? HOUSE_BPS_WEEKLY : HOUSE_BPS_DAILY) / 10_000);
        r.pool += uint128(toPool);
        r.entries += 1;
        if (p.entries == 0) r.players += 1;
        p.entries += 1;

        emit Entered(mode, roundId, msg.sender, ref, r.pool);
    }

    // ─────────────────────────────── scoring ─────────────────────────────────
    /// The digest the score server signs (EIP-191 "\x19Ethereum Signed Message:\n32").
    function scoreDigest(address player, uint8 mode, uint256 roundId, uint256 nonce, uint256 timeMs)
        public
        view
        returns (bytes32)
    {
        bytes32 inner =
            keccak256(abi.encode(SCORE_TYPEHASH, block.chainid, address(this), player, mode, roundId, nonce, timeMs));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// Submit a finished game. `nonce` is the attempt number the server signed;
    /// it must be one of this wallet's unused paid entries for that round.
    function submitScore(uint8 mode, uint256 roundId, uint256 nonce, uint256 timeMs, bytes calldata sig)
        external
        validMode(mode)
    {
        require(block.timestamp < roundEnd(mode, roundId) + GRACE, "Round closed");
        require(timeMs > 0 && timeMs <= ROUND_TIME_MS, "Bad time");

        PlayerRound storage p = _players[mode][roundId][msg.sender];
        require(nonce >= p.attempts && nonce < p.entries, "No unused entry");
        require(_recover(scoreDigest(msg.sender, mode, roundId, nonce, timeMs), sig) == signer, "Bad signature");

        p.attempts = uint16(nonce + 1);

        bool newBest = p.bestMs == 0 || timeMs < p.bestMs;
        if (newBest) {
            p.bestMs = uint32(timeMs);
            _updateTop(_rounds[mode][roundId], msg.sender, uint32(timeMs));
        }
        emit Scored(mode, roundId, msg.sender, timeMs, newBest);
    }

    function _updateTop(Round storage r, address who, uint32 ms) internal {
        address[3] memory t = r.top;
        uint32[3] memory tm = r.topMs;

        // Remove this player if already placed (they just improved)
        for (uint256 i = 0; i < 3; i++) {
            if (t[i] == who) {
                for (uint256 j = i; j < 2; j++) {
                    t[j] = t[j + 1];
                    tm[j] = tm[j + 1];
                }
                t[2] = address(0);
                tm[2] = 0;
                break;
            }
        }
        // Insert in time order (ties: earlier submission keeps the higher place)
        for (uint256 i = 0; i < 3; i++) {
            if (t[i] == address(0) || ms < tm[i]) {
                for (uint256 j = 2; j > i; j--) {
                    t[j] = t[j - 1];
                    tm[j] = tm[j - 1];
                }
                t[i] = who;
                tm[i] = ms;
                break;
            }
        }
        r.top = t;
        r.topMs = tm;
    }

    // ─────────────────────────────── settlement ──────────────────────────────
    /// Pay out a finished round. Anyone can call once the round + grace has ended.
    function settle(uint8 mode, uint256 roundId) external validMode(mode) nonReentrant {
        require(block.timestamp >= roundEnd(mode, roundId) + GRACE, "Round not finished");
        Round storage r = _rounds[mode][roundId];
        require(!r.settled, "Already settled");
        r.settled = true;

        uint256 pool = r.pool;
        if (pool == 0) {
            emit Settled(mode, roundId, address(0), address(0), address(0), 0, 0, 0);
            return;
        }

        if (r.top[0] == address(0)) {
            // Nobody finished — roll the whole pool into the live round
            uint256 toRound = currentRound(mode);
            _rounds[mode][toRound].pool += uint128(pool);
            emit RolledOver(mode, roundId, toRound, pool);
            return;
        }

        uint256 s1 = pool * FIRST_BPS / 10_000;
        uint256 s2 = pool * SECOND_BPS / 10_000;
        uint256 s3 = pool - s1 - s2;
        if (r.top[2] == address(0)) {
            s1 += s3;
            s3 = 0;
        }
        if (r.top[1] == address(0)) {
            s1 += s2;
            s2 = 0;
        }

        _pay(r.top[0], s1);
        _pay(r.top[1], s2);
        _pay(r.top[2], s3);
        emit Settled(mode, roundId, r.top[0], r.top[1], r.top[2], s1, s2, s3);
    }

    function _pay(address to, uint256 amount) internal {
        if (to == address(0) || amount == 0) return;
        (bool ok,) = payable(to).call{value: amount, gas: PAY_GAS}("");
        if (!ok) {
            claimable[to] += amount;
            emit Credited(to, amount, "prize");
        }
    }

    /// Withdraw anything owed to you (house cut, referral earnings, bounced prizes).
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        require(amount > 0, "Nothing to claim");
        claimable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
        emit Claimed(msg.sender, amount);
    }

    // ─────────────────────────────── views ───────────────────────────────────
    function getRound(uint8 mode, uint256 roundId)
        external
        view
        validMode(mode)
        returns (
            uint256 pool,
            uint256 entries,
            uint256 players,
            bool settled,
            uint256 endTime,
            address[3] memory top,
            uint32[3] memory topMs
        )
    {
        Round storage r = _rounds[mode][roundId];
        return (r.pool, r.entries, r.players, r.settled, roundEnd(mode, roundId), r.top, r.topMs);
    }

    function getPlayer(uint8 mode, uint256 roundId, address player)
        external
        view
        validMode(mode)
        returns (uint256 entries, uint256 attempts, uint256 bestMs)
    {
        PlayerRound storage p = _players[mode][roundId][player];
        return (p.entries, p.attempts, p.bestMs);
    }

    // ─────────────────────────────── admin ───────────────────────────────────
    // The owner can rotate the score-server key and pause NEW entries.
    // The owner can NOT touch prize pools, change fees or move anyone's money.
    function setSigner(address _signer) external onlyOwner {
        require(_signer != address(0), "Zero address");
        signer = _signer;
        emit SignerChanged(_signer);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setOwner(address _owner) external onlyOwner {
        require(_owner != address(0), "Zero address");
        owner = _owner;
        emit OwnerChanged(_owner);
    }

    // ─────────────────────────────── signature recovery ──────────────────────
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Bad v");
        // Reject malleable signatures (upper-half s)
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "Bad s");
        address a = ecrecover(digest, v, r, s);
        require(a != address(0), "Bad signature");
        return a;
    }

    receive() external payable {
        // Stray AVAX is credited to the house rather than lost
        claimable[house] += msg.value;
        emit Credited(house, msg.value, "direct");
    }
}
