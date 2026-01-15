import { IsString, IsOptional, IsEnum, IsNumber } from 'class-validator';

export class UpdateModuleDto {
  @IsOptional()
  @IsString()
  courseId?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  shortDescription?: string;

  @IsOptional()
  @IsEnum(['draft', 'published', 'archived'])
  status?: string;

  @IsOptional()
  @IsNumber()
  orderIndex?: number;
}
