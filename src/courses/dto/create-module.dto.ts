import { IsString, IsOptional, IsEnum, IsNumber } from 'class-validator';

export class CreateModuleDto {
  @IsString()
  courseId: string;

  @IsString()
  title: string;

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


