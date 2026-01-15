import { IsString, IsEnum, IsOptional, IsNumber } from 'class-validator';

export class UpdateMaterialDto {
  @IsOptional()
  @IsString()
  lessonId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(['PDF', 'DOC', 'XLS', 'PPT', 'LINK', 'OTHER'])
  type?: string;

  @IsOptional()
  @IsString()
  link?: string;

  @IsOptional()
  @IsString()
  filePath?: string;

  @IsOptional()
  @IsNumber()
  orderIndex?: number;
}
