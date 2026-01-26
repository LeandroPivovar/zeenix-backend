import { Controller, Get, UseGuards } from '@nestjs/common';
import { KiwifyService } from './kiwify.service';
// Assumindo que você tem um Guard de Admin ou Auth, ajustaremos conforme necessário.
// Por enquanto, vou deixar sem Guard específico ou usar o padrão do projeto se eu soubesse.
// Vou olhar os import do support.controller.ts para ver como protegem as rotas.

@Controller('kiwify')
export class KiwifyController {
    constructor(private readonly kiwifyService: KiwifyService) { }

    @Get('users')
    async getUsers() {
        return this.kiwifyService.getUsers();
    }
}
