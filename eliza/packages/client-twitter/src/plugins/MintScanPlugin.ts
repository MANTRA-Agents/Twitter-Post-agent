import { Plugin, elizaLogger, IAgentRuntime } from "@elizaos/core";
import axios from "axios";

const API_BASE_URL = "https://apis.mintscan.io/v1";
const NETWORK = "mantra";
const NODE_INFO_URL = `${API_BASE_URL}/${NETWORK}/node_info`;

interface StakingParams {
  unbonding_time: string;
  max_validators: number;
  min_commission_rate: string;
  bond_denom: string;
}

interface GovernanceParams {
  quorum: string;
  threshold: string;
  veto_threshold: string;
}

interface SlashingParams {
  signed_blocks_window: string;
  min_signed_per_window: string;
  downtime_jail_duration: string;
  slash_fraction_double_sign: string;
  slash_fraction_downtime: string;
}

interface NodeInfo {
  network: string;
  stakingParams: { params: StakingParams };
  tallyingParams: { tally_params: GovernanceParams };
  slashingParams: { params: SlashingParams };
}

export class MintscanPlugin implements Plugin {
  name = "MintscanPlugin";
  description = "Fetches staking, governance, and security insights from Mintscan API";
  private runtime?: IAgentRuntime;

  constructor(runtime?: IAgentRuntime) {
    this.runtime = runtime;
  }

  init(params: { runtime: IAgentRuntime }): void {
    this.runtime = params.runtime;
  }

  private async fetchNodeInfo(): Promise<NodeInfo | null> {
    try {
        const API_TOKEN = this.runtime.getSetting("MINTSCAN_API_TOKEN");
      const response = await axios.get<NodeInfo>(NODE_INFO_URL, {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
        },
      });
      return response.data;
    } catch (error) {
      elizaLogger.error("[MintscanPlugin] Error fetching node info:", error);
      return null;
    }
  }

  public async getStakingInsights(): Promise<object | null> {
    const nodeInfo = await this.fetchNodeInfo();
    if (!nodeInfo) return null;
    return {
      unbondingTime: nodeInfo.stakingParams.params.unbonding_time,
      maxValidators: nodeInfo.stakingParams.params.max_validators,
      minCommissionRate: nodeInfo.stakingParams.params.min_commission_rate,
      bondDenom: nodeInfo.stakingParams.params.bond_denom,
    };
  }

  public async getGovernanceInsights(): Promise<object | null> {
    const nodeInfo = await this.fetchNodeInfo();
    if (!nodeInfo) return null;
    return {
      quorum: nodeInfo.tallyingParams.tally_params.quorum,
      threshold: nodeInfo.tallyingParams.tally_params.threshold,
      vetoThreshold: nodeInfo.tallyingParams.tally_params.veto_threshold,
    };
  }

  public async getSlashingInsights(): Promise<object | null> {
    const nodeInfo = await this.fetchNodeInfo();
    if (!nodeInfo) return null;
    return {
      signedBlocksWindow: nodeInfo.slashingParams.params.signed_blocks_window,
      minSignedPerWindow: nodeInfo.slashingParams.params.min_signed_per_window,
      downtimeJailDuration: nodeInfo.slashingParams.params.downtime_jail_duration,
      slashFractionDoubleSign: nodeInfo.slashingParams.params.slash_fraction_double_sign,
      slashFractionDowntime: nodeInfo.slashingParams.params.slash_fraction_downtime,
    };
  }

  cleanup(): void {
    elizaLogger.log("[MintscanPlugin] Cleanup complete.");
  }
}
