import { IsString, IsEnum, IsOptional, IsNumber } from 'class-validator';

export class CreateMaterialDto {
  @IsString()
  lessonId: string;

  @IsString()
  name: string;

  @IsEnum(['PDF', 'DOC', 'XLS', 'PPT', 'LINK', 'OTHER'])
  type: string;

  @IsString()
  link: string;

  @IsOptional()
  @IsString()
  filePath?: string;

  @IsOptional()
  @IsNumber()
  orderIndex?: number;
}
