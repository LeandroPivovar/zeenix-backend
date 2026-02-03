import { Controller, Put, Get, Param, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StrategiesService } from './strategies.service';

@Controller('strategies')
@UseGuards(JwtAuthGuard)
export class StrategiesController {
    constructor(private readonly strategiesService: StrategiesService) { }

    @Put(':strategyName')
    async updateStrategy(
        @Param('strategyName') strategyName: string,
        @Body() strategyData: any,
    ) {
        await this.strategiesService.updateStrategyFile(strategyName, strategyData);
        return {
            success: true,
            message: `Strategy "${strategyName}" updated successfully`,
        };
    }

    @Get(':strategyName')
    async getStrategy(@Param('strategyName') strategyName: string) {
        const data = await this.strategiesService.getStrategyFile(strategyName);
        return {
            success: true,
            data,
        };
    }
}
