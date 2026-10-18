// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/BlockHuntV3.sol";

contract RejectsAvax {
    BlockHuntV3 bh;

    constructor(BlockHuntV3 _bh) {
        bh = _bh;
    }

    function enter(uint8 mode) external payable {
        bh.enter{value: msg.value}(mode, address(0));
    }

    function submit(uint8 mode, uint256 roundId, uint256 nonce, uint256 ms, bytes calldata sig) external {
        bh.submitScore(mode, roundId, nonce, ms, sig);
    }

    function claimIt() external {
        bh.claim();
    }

    receive() external payable {
        revert("no thanks");
    }
}

contract BlockHuntV3Test is Test {
    BlockHuntV3 bh;
    uint256 signerKey = 0xA11CE;
    address signer;
    address house = makeAddr("house");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    uint8 constant EASY = 0;
    uint8 constant HARD = 1;
    uint8 constant WEEKLY = 2;

    function setUp() public {
        vm.warp(1_780_000_000); // a fixed point in mid 2026
        signer = vm.addr(signerKey);
        bh = new BlockHuntV3(house, signer);
        for (uint256 i; i < 4; i++) {
            vm.deal([alice, bob, carol, dave][i], 10 ether);
        }
    }

    // ── helpers ──
    function _sig(address player, uint8 mode, uint256 roundId, uint256 nonce, uint256 ms)
        internal
        view
        returns (bytes memory)
    {
        return _sigWith(signerKey, player, mode, roundId, nonce, ms);
    }

    function _sigWith(uint256 key, address player, uint8 mode, uint256 roundId, uint256 nonce, uint256 ms)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, bh.scoreDigest(player, mode, roundId, nonce, ms));
        return abi.encodePacked(r, s, v);
    }

    function _enter(address who, uint8 mode) internal {
        uint256 fee = bh.feeOf(mode);
        vm.prank(who);
        bh.enter{value: fee}(mode, address(0));
    }

    function _score(address who, uint8 mode, uint256 nonce, uint256 ms) internal {
        uint256 id = bh.currentRound(mode);
        bytes memory sig = _sig(who, mode, id, nonce, ms);
        vm.prank(who);
        bh.submitScore(mode, id, nonce, ms, sig);
    }

    function _pool(uint8 mode, uint256 id) internal view returns (uint256 pool) {
        (pool,,,,,,) = bh.getRound(mode, id);
    }

    function _top(uint8 mode, uint256 id) internal view returns (address[3] memory top, uint32[3] memory ms) {
        (,,,,, top, ms) = bh.getRound(mode, id);
    }

    function _toSettle(uint8 mode, uint256 id) internal {
        vm.warp(bh.roundEnd(mode, id) + bh.GRACE());
    }

    // ── entering ──
    function test_EnterSplitsFeeIntoPoolAndHouse() public {
        _enter(alice, EASY);
        uint256 id = bh.currentRound(EASY);
        assertEq(_pool(EASY, id), 0.0475 ether);
        assertEq(bh.claimable(house), 0.0025 ether);
        (uint256 entries,,) = bh.getPlayer(EASY, id, alice);
        assertEq(entries, 1);
    }

    function test_WeeklyHouseCutIsTenPercent() public {
        _enter(alice, WEEKLY);
        assertEq(_pool(WEEKLY, bh.currentRound(WEEKLY)), 0.09 ether);
        assertEq(bh.claimable(house), 0.01 ether);
    }

    function test_WrongFeeReverts() public {
        vm.prank(alice);
        vm.expectRevert("Wrong fee");
        bh.enter{value: 0.04 ether}(EASY, address(0));
    }

    function test_BadModeReverts() public {
        vm.prank(alice);
        vm.expectRevert("Bad mode");
        bh.enter{value: 0.05 ether}(3, address(0));
    }

    function test_MultipleEntriesCountPlayersOnce() public {
        _enter(alice, HARD);
        _enter(alice, HARD);
        _enter(bob, HARD);
        (, uint256 entries, uint256 players,,,,) = bh.getRound(HARD, bh.currentRound(HARD));
        assertEq(entries, 3);
        assertEq(players, 2);
    }

    function test_ReferralPaidFromHouseCutAndRecordedOnce() public {
        vm.prank(alice);
        bh.enter{value: 0.05 ether}(EASY, bob);
        assertEq(bh.referrerOf(alice), bob);
        assertEq(bh.claimable(bob), 0.001 ether); // 2%
        assertEq(bh.claimable(house), 0.0015 ether); // 5% - 2%
        assertEq(_pool(EASY, bh.currentRound(EASY)), 0.0475 ether); // pool untouched

        // Later entries keep the original referrer even if another is passed
        vm.prank(alice);
        bh.enter{value: 0.05 ether}(EASY, carol);
        assertEq(bh.referrerOf(alice), bob);
        assertEq(bh.claimable(bob), 0.002 ether);
        assertEq(bh.claimable(carol), 0);
    }

    function test_SelfReferralIgnored() public {
        vm.prank(alice);
        bh.enter{value: 0.05 ether}(EASY, alice);
        assertEq(bh.referrerOf(alice), address(0));
        assertEq(bh.claimable(house), 0.0025 ether);
    }

    function test_PausedBlocksEntries() public {
        vm.prank(house);
        bh.setPaused(true);
        vm.prank(alice);
        vm.expectRevert("Entries paused");
        bh.enter{value: 0.05 ether}(EASY, address(0));
    }

    // ── scoring ──
    function test_ValidScoreRecorded() public {
        _enter(alice, EASY);
        _score(alice, EASY, 0, 42_000);
        (, uint256 attempts, uint256 best) = bh.getPlayer(EASY, bh.currentRound(EASY), alice);
        assertEq(attempts, 1);
        assertEq(best, 42_000);
        (address[3] memory top, uint32[3] memory ms) = _top(EASY, bh.currentRound(EASY));
        assertEq(top[0], alice);
        assertEq(ms[0], 42_000);
    }

    /// The V2 exploit: submitting a fake time without the server's signature.
    function test_FakeTimeWithoutServerSignatureRejected() public {
        _enter(alice, EASY);
        uint256 id = bh.currentRound(EASY);
        bytes memory forged = _sigWith(0xBAD, alice, EASY, id, 0, 1);
        vm.prank(alice);
        vm.expectRevert("Bad signature");
        bh.submitScore(EASY, id, 0, 1, forged);
    }

    function test_SignatureForOtherTimeRejected() public {
        _enter(alice, EASY);
        uint256 id = bh.currentRound(EASY);
        bytes memory sig = _sig(alice, EASY, id, 0, 60_000);
        vm.prank(alice);
        vm.expectRevert("Bad signature");
        bh.submitScore(EASY, id, 0, 1_000, sig);
    }

    function test_SignatureForOtherPlayerRejected() public {
        _enter(alice, EASY);
        _enter(bob, EASY);
        uint256 id = bh.currentRound(EASY);
        bytes memory sig = _sig(alice, EASY, id, 0, 30_000);
        vm.prank(bob);
        vm.expectRevert("Bad signature");
        bh.submitScore(EASY, id, 0, 30_000, sig);
    }

    function test_SignatureForOtherModeRejected() public {
        _enter(alice, EASY);
        _enter(alice, HARD);
        uint256 id = bh.currentRound(EASY);
        bytes memory sig = _sig(alice, EASY, id, 0, 30_000);
        vm.prank(alice);
        vm.expectRevert("Bad signature");
        bh.submitScore(HARD, id, 0, 30_000, sig);
    }

    function test_MalleableSignatureRejected() public {
        _enter(alice, EASY);
        uint256 id = bh.currentRound(EASY);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, bh.scoreDigest(alice, EASY, id, 0, 30_000));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(alice);
        vm.expectRevert("Bad s");
        bh.submitScore(EASY, id, 0, 30_000, flipped);
    }

    function test_NoEntryNoScore() public {
        uint256 id = bh.currentRound(EASY);
        bytes memory sig = _sig(alice, EASY, id, 0, 30_000);
        vm.prank(alice);
        vm.expectRevert("No unused entry");
        bh.submitScore(EASY, id, 0, 30_000, sig);
    }

    function test_EachEntryIsOneAttempt() public {
        _enter(alice, EASY);
        _score(alice, EASY, 0, 50_000);
        uint256 id = bh.currentRound(EASY);
        // Replay the same attempt
        bytes memory sig = _sig(alice, EASY, id, 0, 50_000);
        vm.prank(alice);
        vm.expectRevert("No unused entry");
        bh.submitScore(EASY, id, 0, 50_000, sig);
        // Next attempt needs another paid entry
        sig = _sig(alice, EASY, id, 1, 20_000);
        vm.prank(alice);
        vm.expectRevert("No unused entry");
        bh.submitScore(EASY, id, 1, 20_000, sig);
        _enter(alice, EASY);
        _score(alice, EASY, 1, 20_000);
        (,, uint256 best) = bh.getPlayer(EASY, id, alice);
        assertEq(best, 20_000);
    }

    function test_SkippingAbandonedAttemptsConsumesThem() public {
        _enter(alice, EASY);
        _enter(alice, EASY);
        _enter(alice, EASY);
        _score(alice, EASY, 2, 25_000); // attempts 0 and 1 abandoned
        uint256 id = bh.currentRound(EASY);
        (, uint256 attempts,) = bh.getPlayer(EASY, id, alice);
        assertEq(attempts, 3);
        bytes memory sig = _sig(alice, EASY, id, 0, 10_000);
        vm.prank(alice);
        vm.expectRevert("No unused entry");
        bh.submitScore(EASY, id, 0, 10_000, sig);
    }

    function test_SlowerRetryKeepsBest() public {
        _enter(alice, EASY);
        _enter(alice, EASY);
        _score(alice, EASY, 0, 30_000);
        _score(alice, EASY, 1, 45_000);
        (,, uint256 best) = bh.getPlayer(EASY, bh.currentRound(EASY), alice);
        assertEq(best, 30_000);
    }

    function test_TimeBounds() public {
        _enter(alice, EASY);
        uint256 id = bh.currentRound(EASY);
        bytes memory sig = _sig(alice, EASY, id, 0, 0);
        vm.prank(alice);
        vm.expectRevert("Bad time");
        bh.submitScore(EASY, id, 0, 0, sig);
        sig = _sig(alice, EASY, id, 0, 120_001);
        vm.prank(alice);
        vm.expectRevert("Bad time");
        bh.submitScore(EASY, id, 0, 120_001, sig);
    }

    function test_ScoreAllowedInGraceButNotAfter() public {
        _enter(alice, EASY);
        uint256 id = bh.currentRound(EASY);
        bytes memory sig = _sig(alice, EASY, id, 0, 30_000);
        vm.warp(bh.roundEnd(EASY, id) + bh.GRACE() - 1);
        vm.prank(alice);
        bh.submitScore(EASY, id, 0, 30_000, sig);

        _enterAt(bob, EASY, id);
        sig = _sig(bob, EASY, id, 0, 20_000);
        vm.warp(bh.roundEnd(EASY, id) + bh.GRACE());
        vm.prank(bob);
        vm.expectRevert("Round closed");
        bh.submitScore(EASY, id, 0, 20_000, sig);
    }

    function _enterAt(address who, uint8 mode, uint256 id) internal {
        uint256 t = block.timestamp;
        vm.warp(bh.roundEnd(mode, id) - 60);
        _enter(who, mode);
        vm.warp(t);
    }

    function test_TopThreeOrderingAndImprovement() public {
        _enter(alice, HARD);
        _enter(bob, HARD);
        _enter(carol, HARD);
        _enter(dave, HARD);
        _score(alice, HARD, 0, 40_000);
        _score(bob, HARD, 0, 30_000);
        _score(carol, HARD, 0, 50_000);
        _score(dave, HARD, 0, 60_000); // 4th, not placed
        uint256 id = bh.currentRound(HARD);
        (address[3] memory top, uint32[3] memory ms) = _top(HARD, id);
        assertEq(top[0], bob);
        assertEq(top[1], alice);
        assertEq(top[2], carol);
        assertEq(ms[2], 50_000);

        // Carol improves to first
        _enter(carol, HARD);
        _score(carol, HARD, 1, 10_000);
        (top, ms) = _top(HARD, id);
        assertEq(top[0], carol);
        assertEq(top[1], bob);
        assertEq(top[2], alice);

        // Dave sneaks into 3rd
        _enter(dave, HARD);
        _score(dave, HARD, 1, 35_000);
        (top, ms) = _top(HARD, id);
        assertEq(top[2], dave);
        assertEq(ms[2], 35_000);
    }

    function test_TieKeepsEarlierScoreAhead() public {
        _enter(alice, EASY);
        _enter(bob, EASY);
        _score(alice, EASY, 0, 30_000);
        _score(bob, EASY, 0, 30_000);
        (address[3] memory top,) = _top(EASY, bh.currentRound(EASY));
        assertEq(top[0], alice);
        assertEq(top[1], bob);
    }

    // ── settlement ──
    function test_SettleThreeWinners() public {
        _enter(alice, EASY);
        _enter(bob, EASY);
        _enter(carol, EASY);
        _enter(dave, EASY);
        _score(alice, EASY, 0, 20_000);
        _score(bob, EASY, 0, 30_000);
        _score(carol, EASY, 0, 40_000);
        uint256 id = bh.currentRound(EASY);
        uint256 pool = _pool(EASY, id); // 4 * 0.0475 = 0.19
        assertEq(pool, 0.19 ether);
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        uint256 c0 = carol.balance;
        _toSettle(EASY, id);
        bh.settle(EASY, id);
        assertEq(alice.balance - a0, 0.133 ether); // 70%
        assertEq(bob.balance - b0, 0.038 ether); // 20%
        assertEq(carol.balance - c0, 0.019 ether); // 10%
        assertEq(address(bh).balance, bh.claimable(house));
    }

    function test_SoloWinnerTakesWholePool() public {
        _enter(alice, HARD);
        _enter(bob, HARD); // bob never finishes
        _score(alice, HARD, 0, 70_000);
        uint256 id = bh.currentRound(HARD);
        uint256 pool = _pool(HARD, id);
        uint256 a0 = alice.balance;
        _toSettle(HARD, id);
        bh.settle(HARD, id);
        assertEq(alice.balance - a0, pool);
    }

    function test_TwoWinnersSplitNinetyTen() public {
        _enter(alice, EASY);
        _enter(bob, EASY);
        _score(alice, EASY, 0, 20_000);
        _score(bob, EASY, 0, 30_000);
        uint256 id = bh.currentRound(EASY);
        uint256 pool = _pool(EASY, id);
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        _toSettle(EASY, id);
        bh.settle(EASY, id);
        assertEq(bob.balance - b0, pool * 2000 / 10_000);
        assertEq(alice.balance - a0, pool - pool * 2000 / 10_000);
    }

    function test_NoScoresRollsIntoLiveRound() public {
        _enter(alice, EASY);
        _enter(bob, EASY);
        uint256 id = bh.currentRound(EASY);
        uint256 pool = _pool(EASY, id);
        _toSettle(EASY, id);
        bh.settle(EASY, id);
        uint256 live = bh.currentRound(EASY);
        assertGt(live, id);
        assertEq(_pool(EASY, live), pool);
        assertEq(bh.claimable(house), 0.005 ether); // only the normal 5% cut
    }

    function test_CannotSettleEarlyOrTwice() public {
        _enter(alice, EASY);
        uint256 id = bh.currentRound(EASY);
        vm.expectRevert("Round not finished");
        bh.settle(EASY, id);
        vm.warp(bh.roundEnd(EASY, id) + bh.GRACE() - 1);
        vm.expectRevert("Round not finished");
        bh.settle(EASY, id);
        vm.warp(bh.roundEnd(EASY, id) + bh.GRACE());
        bh.settle(EASY, id);
        vm.expectRevert("Already settled");
        bh.settle(EASY, id);
    }

    function test_EmptyRoundSettlesCleanly() public {
        uint256 id = bh.currentRound(HARD);
        _toSettle(HARD, id);
        bh.settle(HARD, id);
    }

    function test_BouncedPrizeBecomesClaimable() public {
        RejectsAvax rej = new RejectsAvax(bh);
        vm.deal(address(rej), 1 ether);
        rej.enter{value: 0.05 ether}(EASY);
        uint256 id = bh.currentRound(EASY);
        rej.submit(EASY, id, 0, 30_000, _sig(address(rej), EASY, id, 0, 30_000));
        _enter(alice, EASY);
        _score(alice, EASY, 0, 40_000);
        uint256 pool = _pool(EASY, id);
        uint256 a0 = alice.balance;
        _toSettle(EASY, id);
        bh.settle(EASY, id); // must not revert even though 1st place rejects AVAX
        assertEq(bh.claimable(address(rej)), pool * 7000 / 10_000 + (pool - pool * 7000 / 10_000 - pool * 2000 / 10_000));
        assertEq(alice.balance - a0, pool * 2000 / 10_000);
    }

    function test_ClaimHouseAndReferral() public {
        vm.prank(alice);
        bh.enter{value: 0.1 ether}(WEEKLY, bob);
        uint256 h0 = house.balance;
        uint256 b0 = bob.balance;
        vm.prank(house);
        bh.claim();
        vm.prank(bob);
        bh.claim();
        assertEq(house.balance - h0, 0.008 ether); // 10% - 2%
        assertEq(bob.balance - b0, 0.002 ether);
        vm.prank(bob);
        vm.expectRevert("Nothing to claim");
        bh.claim();
    }

    function test_DirectTransferCreditedToHouse() public {
        vm.prank(alice);
        (bool ok,) = address(bh).call{value: 0.3 ether}("");
        assertTrue(ok);
        assertEq(bh.claimable(house), 0.3 ether);
    }

    // ── time math ──
    function test_WeeklyRoundsStartSundayMidnightUTC() public view {
        // Sun 4 Jan 1970 00:00 UTC is day 3
        assertEq(bh.roundIdAt(WEEKLY, 3 days), 1);
        assertEq(bh.roundIdAt(WEEKLY, 3 days - 1), 0);
        assertEq(bh.roundEnd(WEEKLY, 1), 10 days);
        // Sun 18 Oct 2026 00:00 UTC = 1792281600
        uint256 sunday = 1_792_281_600;
        uint256 id = bh.roundIdAt(WEEKLY, sunday);
        assertEq(bh.roundIdAt(WEEKLY, sunday - 1), id - 1);
        assertEq(bh.roundEnd(WEEKLY, id), sunday + 7 days);
    }

    function test_DailyRoundsAreUtcDays() public view {
        uint256 id = bh.currentRound(EASY);
        assertEq(bh.roundEnd(EASY, id), (block.timestamp / 1 days + 1) * 1 days);
        assertEq(bh.currentRound(EASY), bh.currentRound(HARD));
    }

    // ── admin ──
    function test_OnlyOwnerAdmin() public {
        vm.prank(alice);
        vm.expectRevert("Not owner");
        bh.setSigner(alice);
        vm.prank(alice);
        vm.expectRevert("Not owner");
        bh.setPaused(true);
        vm.prank(house);
        bh.setSigner(alice);
        assertEq(bh.signer(), alice);
    }

    function test_RotatedSignerInvalidatesOldKey() public {
        _enter(alice, EASY);
        uint256 id = bh.currentRound(EASY);
        bytes memory sig = _sig(alice, EASY, id, 0, 30_000);
        vm.prank(house);
        bh.setSigner(vm.addr(0xB0B));
        vm.prank(alice);
        vm.expectRevert("Bad signature");
        bh.submitScore(EASY, id, 0, 30_000, sig);
    }

    // ── invariant-style fuzz: contract balance always covers what it owes ──
    function testFuzz_SolventAfterRandomPlay(uint8 n, uint32 seed) public {
        n = uint8(bound(n, 1, 25));
        address[4] memory ppl = [alice, bob, carol, dave];
        for (uint256 i; i < n; i++) {
            address who = ppl[uint256(keccak256(abi.encode(seed, i))) % 4];
            uint8 mode = uint8(uint256(keccak256(abi.encode(seed, i, "m"))) % 3);
            uint256 fee = bh.feeOf(mode);
            vm.prank(who);
            bh.enter{value: fee}(mode, ppl[(i + 1) % 4]);
            (uint256 e, uint256 a,) = bh.getPlayer(mode, bh.currentRound(mode), who);
            if (uint256(keccak256(abi.encode(seed, i, "s"))) % 3 != 0) {
                uint256 ms = 1_000 + uint256(keccak256(abi.encode(seed, i, "t"))) % 119_000;
                _score(who, mode, e - 1 >= a ? e - 1 : a, ms);
            }
        }
        uint256 idD = bh.currentRound(EASY);
        uint256 idW = bh.currentRound(WEEKLY);
        vm.warp(bh.roundEnd(WEEKLY, idW) + bh.GRACE());
        bh.settle(EASY, idD);
        bh.settle(HARD, idD);
        bh.settle(WEEKLY, idW);
        uint256 owed = bh.claimable(house) + bh.claimable(alice) + bh.claimable(bob) + bh.claimable(carol)
            + bh.claimable(dave) + _pool(EASY, bh.currentRound(EASY)) + _pool(HARD, bh.currentRound(HARD))
            + _pool(WEEKLY, bh.currentRound(WEEKLY));
        assertEq(address(bh).balance, owed);
    }
}
