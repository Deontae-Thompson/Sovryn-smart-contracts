const path = require("path");
const col = require("cli-color");
//const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));
const func = async function (hre) {
    const {
        ethers,
        deployments: { deploy, log },
        getNamedAccounts,
    } = hre;
    const { deployer } = await getNamedAccounts(); //await ethers.getSigners();

    const fallbackOracle = await get("FallbackOracle");
    const mocMedianizer = await get("MoCMedianizer");
    log(col.bgYellow("Deploying PriceFeedsMoC..."));
    await deploy("PriceFeedsMoC", {
        from: deployer,
        args: [mocMedianizer.address, fallbackOracle.address],
        log: true,
        skipIfAlreadyDeployed: true,
    });

    const priceFeedsMoC = await ethers.getContract("PriceFeedsMoC");
    const governorAdmin = await get("GovernorAdmin");
    log(col.bgYellow("Transferring ownership of priceFeedsMoC to governor admin..."));
    await priceFeedsMoC.transferOwnership(governorAdmin.address);
    log(col.bgYellow(`New priceFeedsMoC owner ${await priceFeedsMoC.owner()}`));
};
func.tags = ["PriceFeedsMoC"];
module.exports = func;
