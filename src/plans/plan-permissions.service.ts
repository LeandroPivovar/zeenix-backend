import { Injectable, Logger } from '@nestjs/common';
import { UserEntity } from '../infrastructure/database/entities/user.entity';

/**
 * Service to centralize all logic related to plan-based permissions and feature access.
 */
@Injectable()
export class PlanPermissionsService {
    private readonly logger = new Logger(PlanPermissionsService.name);

    /**
     * Checks if a user can activate a specific investment strategy (IA)
     * 
     * @param user The user entity with joined plan information
     * @param strategyId The ID or name of the strategy (e.g., 'Orion', 'Atlas')
     * @returns boolean true if allowed
     */
    canActivateStrategy(user: UserEntity, strategyId: string): boolean {
        // Admins and Support always have access
        if (user.role === 'admin' || user.role === 'support') return true;

        if (!user.plan) {
            this.logger.warn(`[canActivateStrategy] User ${user.id} has no plan assigned.`);
            return false;
        }

        const features = user.plan.features || {};
        const lowerId = strategyId.toLowerCase();

        // 1. Check if it's explicitly in the 'ias' list
        if (Array.isArray(features.ias)) {
            if (features.ias.some((id: string) => id.toLowerCase() === lowerId)) {
                return true;
            }
        }

        // 2. Legacy boolean checks
        if (lowerId === 'orion' && features.orion_ai === true) return true;
        if (lowerId === 'atlas' && features.atlas_ai === true) return true;
        if (lowerId === 'nexus' && features.nexus_ai === true) return true;

        // 3. Special case for Orion Black (usually requires specific flag)
        if (lowerId.includes('black') && (features.black_module === true || features.orion_black === true)) {
            return true;
        }

        return false;
    }

    /**
     * Checks if a user can activate a specific autonomous agent
     * 
     * @param user The user entity with joined plan information
     * @param agentId The ID or name of the agent (e.g., 'Zeus', 'Falcon')
     * @returns boolean true if allowed
     */
    canActivateAgent(user: UserEntity, agentId: string): boolean {
        // Admins and Support always have access
        if (user.role === 'admin' || user.role === 'support') return true;

        if (!user.plan) return false;

        const features = user.plan.features || {};
        const lowerId = agentId.toLowerCase();

        // 1. Check if it's explicitly in the 'agents' list
        if (Array.isArray(features.agents)) {
            if (features.agents.some((id: string) => id.toLowerCase() === lowerId)) {
                return true;
            }
        }

        // 2. Global autonomous agent permission
        if (features.autonomous_agent === true) return true;

        return false;
    }

    /**
     * Checks if a user can activate copy trading with a specific master trader
     * 
     * @param user The user entity with joined plan information
     * @param traderId The ID of the master trader
     * @returns boolean true if allowed
     */
    canActivateTrader(user: UserEntity, traderId: string): boolean {
        // Admins and Support always have access
        if (user.role === 'admin' || user.role === 'support') return true;

        if (!user.plan) return false;

        const features = user.plan.features || {};

        // 1. Check if it's explicitly in the 'traders' list (if restricted by ID)
        if (Array.isArray(features.traders)) {
            if (features.traders.some((id: any) => id.toString() === traderId.toString())) {
                return true;
            }
        }

        // 2. Global copy trading permission
        if (features.copy_trading === true) return true;

        return false;
    }
}
