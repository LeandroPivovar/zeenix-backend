import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StrategiesService {
    private readonly strategiesPath: string;

    constructor() {
        // Path to frontend strategies directory
        this.strategiesPath = path.join(__dirname, '../../../frontend/src/utils/strategies');
    }

    async updateStrategyFile(strategyName: string, strategyData: any): Promise<void> {
        // Validate strategy name (no path traversal)
        const normalizedName = strategyName.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
        if (!normalizedName || normalizedName.length < 2) {
            throw new BadRequestException('Invalid strategy name');
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
        // Validate strategy name (no path traversal)
        const normalizedName = strategyName.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
        if (!normalizedName || normalizedName.length < 2) {
            throw new BadRequestException('Invalid strategy name');
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

    async listStrategyFiles(): Promise<string[]> {
        try {
            const files = await fs.promises.readdir(this.strategiesPath);
            return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        } catch (error) {
            console.error(`[StrategiesService] Failed to list strategy files:`, error);
            return [];
        }
    }
}
