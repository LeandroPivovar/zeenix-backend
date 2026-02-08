import { IsNumber, IsString, IsNotEmpty } from 'class-validator';

export class CreateAiTradeLogDto {
    @IsNumber()
    @IsNotEmpty()
    aiSessionsId: number;

    @IsNumber()
    @IsNotEmpty()
    investedValue: number;

    @IsNumber()
    @IsNotEmpty()
    returnedValue: number;

    @IsString()
    @IsNotEmpty()
    result: string;
}
