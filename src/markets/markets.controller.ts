import { Controller, Get, Post } from '@nestjs/common';
import { MarketsService } from './markets.service';
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { RolesGuard } from '../auth/guards/roles.guard';
// import { Roles } from '../auth/decorators/roles.decorator';

@Controller('markets')
export class MarketsController {
    constructor(private readonly marketsService: MarketsService) { }

    @Get()
    async findAll() {
        return this.marketsService.findAll();
    }

    @Post('sync')
    // @UseGuards(JwtAuthGuard, RolesGuard)
    // @Roles('admin') // Uncomment to restrict to admin
    async syncMarkets() {
        return this.marketsService.syncMarkets();
    }
}
