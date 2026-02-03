import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StrategiesService {
    private readonly strategiesPath: string;
    private readonly allowedStrategies = ['apollo', 'atlas', 'nexus', 'orion', 'titan'];

    constructor() {
        // Path to frontend strategies directory
        this.strategiesPath = path.join(__dirname, '../../../frontend/src/utils/strategies');
    }

    async updateStrategyFile(strategyName: string, strategyData: any): Promise<void> {
        // Validate strategy name
        const normalizedName = strategyName.toLowerCase().trim();
        if (!this.allowedStrategies.includes(normalizedName)) {
            throw new BadRequestException(
                `Strategy name must be one of: ${this.allowedStrategies.join(', ')}`
            );
        }

        // Validate data structure
        if (!strategyData.config || !strategyData.config.form) {
            throw new BadRequestException('Invalid strategy data structure');
        }

        const filePath = path.join(this.strategiesPath, `${normalizedName}.json`);

        try {
            // Ensure directory exists
            await fs.promises.mkdir(this.strategiesPath, { recursive: true });

            // Write file with pretty formatting
            await fs.promises.writeFile(
                filePath,
                JSON.stringify(strategyData, null, 2),
                'utf-8'
            );

            console.log(`[StrategiesService] Updated strategy file: ${normalizedName}.json`);
        } catch (error) {
            console.error(`[StrategiesService] Failed to write strategy file:`, error);
            throw new InternalServerErrorException('Failed to update strategy file');
        }
    }

    async getStrategyFile(strategyName: string): Promise<any> {
        const normalizedName = strategyName.toLowerCase().trim();
        if (!this.allowedStrategies.includes(normalizedName)) {
            throw new BadRequestException(
                `Strategy name must be one of: ${this.allowedStrategies.join(', ')}`
            );
        }

        const filePath = path.join(this.strategiesPath, `${normalizedName}.json`);

        try {
            const fileContent = await fs.promises.readFile(filePath, 'utf-8');
            return JSON.parse(fileContent);
        } catch (error) {
            console.error(`[StrategiesService] Failed to read strategy file:`, error);
            throw new InternalServerErrorException('Failed to read strategy file');
        }
    }
}
