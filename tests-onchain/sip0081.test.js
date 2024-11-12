// first run a local forked mainnet node in a separate terminal window:
//     npx hardhat node --fork https://mainnet-dev.sovryn.app/rpc --no-deploy
// now run the test:
//     npx hardhat test tests-onchain/sip0081.test.js --network rskForkedMainnet

const {
    impersonateAccount,
    mine,
    time,
    setBalance,
} = require("@nomicfoundation/hardhat-network-helpers");
const hre = require("hardhat");
const { getProtocolModules } = require("../deployment/helpers/helpers");

const {
    ethers,
    deployments: { createFixture, get },
} = hre;

const MAX_DURATION = ethers.BigNumber.from(24 * 60 * 60).mul(1092);

const ONE_RBTC = ethers.utils.parseEther("1.0");

const getImpersonatedSigner = async (addressToImpersonate) => {
    await impersonateAccount(addressToImpersonate);
    return await ethers.getSigner(addressToImpersonate);
};

describe("SIP-0081 test onchain", () => {
    const getImpersonatedSignerFromJsonRpcProvider = async (addressToImpersonate) => {
        const provider = new ethers.providers.JsonRpcProvider("http://localhost:8545");
        await provider.send("hardhat_impersonateAccount", [addressToImpersonate]);
        return provider.getSigner(addressToImpersonate);
    };

    const setupTest = createFixture(async ({ deployments }) => {
        const deployer = (await ethers.getSigners())[0].address;
        const deployerSigner = await ethers.getSigner(deployer);

        const multisigAddress = (await get("MultiSigWallet")).address;
        const multisigSigner = await getImpersonatedSignerFromJsonRpcProvider(multisigAddress);

        await setBalance(deployer, ONE_RBTC.mul(10));
        await deployments.fixture(["ProtocolModules"], {
            keepExistingDeployments: true,
        }); // start from a fresh deployments

        const staking = await ethers.getContract("Staking", deployerSigner);
        const sovrynProtocol = await ethers.getContract("SovrynProtocol", deployerSigner);

        const god = await deployments.get("GovernorOwner");
        const governorOwner = await ethers.getContractAt(
            "GovernorAlpha",
            god.address,
            deployerSigner
        );
        const governorOwnerSigner = await getImpersonatedSigner(god.address);

        await setBalance(governorOwnerSigner.address, ONE_RBTC);
        const timelockOwner = await ethers.getContract("TimelockOwner", governorOwnerSigner);

        const timelockOwnerSigner = await getImpersonatedSignerFromJsonRpcProvider(
            timelockOwner.address
        );
        await setBalance(timelockOwnerSigner._address, ONE_RBTC);

        //
        return {
            deployer,
            deployerSigner,
            staking,
            sovrynProtocol,
            governorOwner,
            governorOwnerSigner,
            timelockOwner,
            timelockOwnerSigner,
            multisigAddress,
            multisigSigner,
        };
    });

    describe("SIP-001 Test creation and execution", () => {
        it("SIP-0081 is executable and valid", async () => {
            if (!hre.network.tags["forked"]) {
                console.error("ERROR: Must run on a forked net");
                return;
            }
            await hre.network.provider.request({
                method: "hardhat_reset",
                params: [
                    {
                        forking: {
                            jsonRpcUrl: "https://mainnet-dev.sovryn.app/rpc",
                            blockNumber: 6201800,
                        },
                    },
                ],
            });

            const {
                deployer,
                deployerSigner,
                staking,
                governorOwner,
                timelockOwnerSigner,
                multisigAddress,
                multisigSigner,
            } = await setupTest();

            // CREATE PROPOSAL
            const sov = await ethers.getContract("SOV", timelockOwnerSigner);
            const whaleAmount = (await sov.totalSupply()).mul(ethers.BigNumber.from(5));
            await sov.mint(deployer, whaleAmount);

            await sov.connect(deployerSigner).approve(staking.address, whaleAmount);

            if (await staking.paused()) await staking.connect(multisigSigner).pauseUnpause(false);
            const kickoffTS = await staking.kickoffTS();
            await staking.stake(
                whaleAmount,
                ethers.BigNumber.from(Date.now()).add(MAX_DURATION),
                deployer,
                deployer
            );
            await mine();

            // CREATE PROPOSAL AND VERIFY
            const proposalIdBeforeSIP = await governorOwner.latestProposalIds(deployer);
            await hre.run("sips:create", { argsFunc: "getArgsSip0081" });
            const proposalId = await governorOwner.latestProposalIds(deployer);
            expect(
                proposalId,
                "Proposal was not created. Check the SIP creation is not commented out."
            ).is.gt(proposalIdBeforeSIP);

            // VOTE FOR PROPOSAL

            await mine();
            await governorOwner.connect(deployerSigner).castVote(proposalId, true);

            // QUEUE PROPOSAL
            let proposal = await governorOwner.proposals(proposalId);
            await mine(proposal.endBlock);
            await governorOwner.queue(proposalId);

            const borrowerOperations = await ethers.getContract("BorrowerOperations");
            const stabilityPool = await ethers.getContract("StabilityPool");
            const communityIssuance = await ethers.getContract("CommunityIssuance");
            const troveManager = await ethers.getContract("TroveManager");

            const previousBorrowerOperations_feeDistributor =
                await borrowerOperations.feeDistributor();
            const previousBorrowerOperations_liquityBaseParams =
                await borrowerOperations.liquityBaseParams();
            const previousBorrowerOperations_troveManager =
                await borrowerOperations.troveManager();
            const previousBorrowerOperations_activePool = await borrowerOperations.activePool();
            const previousBorrowerOperations_defaultPool = await borrowerOperations.defaultPool();
            const previousBorrowerOperations_stabilityPoolAddress =
                await ethers.provider.getStorageAt(borrowerOperations.address, 5);
            const previousBorrowerOperations_gasPoolAddress = await ethers.provider.getStorageAt(
                borrowerOperations.address,
                6
            );
            const previousBorrowerOperations_collSurplusPool = await ethers.provider.getStorageAt(
                borrowerOperations.address,
                7
            );
            const previousBorrowerOperations_sortedTroves =
                await borrowerOperations.sortedTroves();
            const previousBorrowerOperations_zusdToken = await borrowerOperations.zusdToken();
            const previousBorrowerOperations_zeroStakingAddress =
                await borrowerOperations.zeroStakingAddress();

            const previousTroveManager_feeDistributor = await troveManager.feeDistributor();
            const previousTroveManager_troveManagerRedeemOps =
                await troveManager.troveManagerRedeemOps();
            const previousTroveManager_liquityBaseParams = await troveManager.liquityBaseParams();
            const previousTroveManager_borrowerOperationsAddress =
                await troveManager.borrowerOperationsAddress();
            const previousTroveManager_activePool = await troveManager.activePool();
            const previousTroveManager_defaultPool = await troveManager.defaultPool();
            const previousTroveManager__stabilityPool = await troveManager._stabilityPool();
            const previousTroveManager__gasPoolAddress = await ethers.provider.getStorageAt(
                borrowerOperations.address,
                7
            );
            const previousTroveManager__collSurplusPool = await ethers.provider.getStorageAt(
                borrowerOperations.address,
                8
            );
            const previousTroveManager__zusdToken = await troveManager._zusdToken();
            const previousTroveManager_sortedTroves = await troveManager.sortedTroves();
            const previousTroveManager__zeroToken = await troveManager._zeroToken();
            const previousTroveManager__zeroStaking = await troveManager._zeroStaking();

            const previousStabilityPool_liquityBaseParams =
                await stabilityPool.liquityBaseParams();
            const previousStabilityPool_borrowerOperations =
                await stabilityPool.borrowerOperations();
            const previousStabilityPool_troveManager = await stabilityPool.troveManager();
            const previousStabilityPool_activePool = await stabilityPool.activePool();
            const previousStabilityPool_zusdToken = await stabilityPool.zusdToken();
            const previousStabilityPool_sortedTroves = await stabilityPool.sortedTroves();
            const previousStabilityPool_communityIssuance =
                await stabilityPool.communityIssuance();

            // EXECUTE PROPOSAL
            proposal = await governorOwner.proposals(proposalId);
            await time.increaseTo(proposal.eta);
            await expect(governorOwner.execute(proposalId))
                .to.emit(governorOwner, "ProposalExecuted")
                .withArgs(proposalId);

            // VERIFY execution
            expect((await governorOwner.proposals(proposalId)).executed).to.be.true;

            const latestBorrowerOperationsPriceFeed = await borrowerOperations.priceFeed();
            const latestStabilityPoolPriceFeed = await stabilityPool.priceFeed();
            const latestCommunityIssuancePriceFeed = await communityIssuance.priceFeed();
            const latestTroveManagerPriceFeed = await troveManager.priceFeed();
            const expectedPriceFeed = (await get("ZeroPriceFeedRevertOnStalePrice")).address; // @todo update the address in the deployment file

            expect(latestBorrowerOperationsPriceFeed).to.equal(expectedPriceFeed);
            expect(latestStabilityPoolPriceFeed).to.equal(expectedPriceFeed);
            expect(latestCommunityIssuancePriceFeed).to.equal(expectedPriceFeed);
            expect(latestTroveManagerPriceFeed).to.equal(expectedPriceFeed);

            // validate BorrowerOperations
            const latestBorrowerOperations_feeDistributor =
                await borrowerOperations.feeDistributor();
            const latestBorrowerOperations_liquityBaseParams =
                await borrowerOperations.liquityBaseParams();
            const latestBorrowerOperations_troveManager = await borrowerOperations.troveManager();
            const latestBorrowerOperations_activePool = await borrowerOperations.activePool();
            const latestBorrowerOperations_defaultPool = await borrowerOperations.defaultPool();
            const latestBorrowerOperations_stabilityPoolAddress =
                await ethers.provider.getStorageAt(borrowerOperations.address, 5);
            const latestBorrowerOperations_gasPoolAddress = await ethers.provider.getStorageAt(
                borrowerOperations.address,
                6
            );
            const latestBorrowerOperations_collSurplusPool = await ethers.provider.getStorageAt(
                borrowerOperations.address,
                7
            );
            const latestBorrowerOperations_sortedTroves = await borrowerOperations.sortedTroves();
            const latestBorrowerOperations_zusdToken = await borrowerOperations.zusdToken();
            const latestBorrowerOperations_zeroStakingAddress =
                await borrowerOperations.zeroStakingAddress();

            expect(previousBorrowerOperations_feeDistributor).to.equal(
                latestBorrowerOperations_feeDistributor
            );
            expect(previousBorrowerOperations_liquityBaseParams).to.equal(
                latestBorrowerOperations_liquityBaseParams
            );
            expect(previousBorrowerOperations_troveManager).to.equal(
                latestBorrowerOperations_troveManager
            );
            expect(previousBorrowerOperations_activePool).to.equal(
                latestBorrowerOperations_activePool
            );
            expect(previousBorrowerOperations_defaultPool).to.equal(
                latestBorrowerOperations_defaultPool
            );
            expect(previousBorrowerOperations_stabilityPoolAddress).to.equal(
                latestBorrowerOperations_stabilityPoolAddress
            );
            expect(previousBorrowerOperations_gasPoolAddress).to.equal(
                latestBorrowerOperations_gasPoolAddress
            );
            expect(previousBorrowerOperations_collSurplusPool).to.equal(
                latestBorrowerOperations_collSurplusPool
            );
            expect(previousBorrowerOperations_sortedTroves).to.equal(
                latestBorrowerOperations_sortedTroves
            );
            expect(previousBorrowerOperations_zusdToken).to.equal(
                latestBorrowerOperations_zusdToken
            );
            expect(previousBorrowerOperations_zeroStakingAddress).to.equal(
                latestBorrowerOperations_zeroStakingAddress
            );

            // validate trove manager
            const latestTroveManager_feeDistributor = await troveManager.feeDistributor();
            const latestTroveManager_troveManagerRedeemOps =
                await troveManager.troveManagerRedeemOps();
            const latestTroveManager_liquityBaseParams = await troveManager.liquityBaseParams();
            const latestTroveManager_borrowerOperationsAddress =
                await troveManager.borrowerOperationsAddress();
            const latestTroveManager_activePool = await troveManager.activePool();
            const latestTroveManager_defaultPool = await troveManager.defaultPool();
            const latestTroveManager__stabilityPool = await troveManager._stabilityPool();
            const latestTroveManager__gasPoolAddress = await ethers.provider.getStorageAt(
                borrowerOperations.address,
                7
            );
            const latestTroveManager__collSurplusPool = await ethers.provider.getStorageAt(
                borrowerOperations.address,
                8
            );
            const latestTroveManager__zusdToken = await troveManager._zusdToken();
            const latestTroveManager_sortedTroves = await troveManager.sortedTroves();
            const latestTroveManager__zeroToken = await troveManager._zeroToken();
            const latestTroveManager__zeroStaking = await troveManager._zeroStaking();

            expect(previousTroveManager_feeDistributor).to.equal(
                latestTroveManager_feeDistributor
            );
            expect(previousTroveManager_troveManagerRedeemOps).to.equal(
                latestTroveManager_troveManagerRedeemOps
            );
            expect(previousTroveManager_liquityBaseParams).to.equal(
                latestTroveManager_liquityBaseParams
            );
            expect(previousTroveManager_borrowerOperationsAddress).to.equal(
                latestTroveManager_borrowerOperationsAddress
            );
            expect(previousTroveManager_activePool).to.equal(latestTroveManager_activePool);
            expect(previousTroveManager_defaultPool).to.equal(latestTroveManager_defaultPool);
            expect(previousTroveManager__stabilityPool).to.equal(
                latestTroveManager__stabilityPool
            );
            expect(previousTroveManager__gasPoolAddress).to.equal(
                latestTroveManager__gasPoolAddress
            );
            expect(previousTroveManager__collSurplusPool).to.equal(
                latestTroveManager__collSurplusPool
            );
            expect(previousTroveManager__zusdToken).to.equal(latestTroveManager__zusdToken);
            expect(previousTroveManager_sortedTroves).to.equal(latestTroveManager_sortedTroves);
            expect(previousTroveManager__zeroToken).to.equal(latestTroveManager__zeroToken);
            expect(previousTroveManager__zeroStaking).to.equal(latestTroveManager__zeroStaking);

            // validate stability pool
            const latestStabilityPool_liquityBaseParams = await stabilityPool.liquityBaseParams();
            const latestStabilityPool_borrowerOperations =
                await stabilityPool.borrowerOperations();
            const latestStabilityPool_troveManager = await stabilityPool.troveManager();
            const latestStabilityPool_activePool = await stabilityPool.activePool();
            const latestStabilityPool_zusdToken = await stabilityPool.zusdToken();
            const latestStabilityPool_sortedTroves = await stabilityPool.sortedTroves();
            const latestStabilityPool_communityIssuance = await stabilityPool.communityIssuance();

            expect(previousStabilityPool_liquityBaseParams).to.equal(
                latestStabilityPool_liquityBaseParams
            );
            expect(previousStabilityPool_borrowerOperations).to.equal(
                latestStabilityPool_borrowerOperations
            );
            expect(previousStabilityPool_troveManager).to.equal(latestStabilityPool_troveManager);
            expect(previousStabilityPool_activePool).to.equal(latestStabilityPool_activePool);
            expect(previousStabilityPool_zusdToken).to.equal(latestStabilityPool_zusdToken);
            expect(previousStabilityPool_sortedTroves).to.equal(latestStabilityPool_sortedTroves);
            expect(previousStabilityPool_communityIssuance).to.equal(
                latestStabilityPool_communityIssuance
            );
        });
    });
});
