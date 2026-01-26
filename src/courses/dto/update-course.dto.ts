import { IsString, IsOptional, IsNumber, IsArray, IsEnum, IsDateString } from 'class-validator';

export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  seoTitle?: string;

  @IsOptional()
  @IsString()
  seoDescription?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  coverImage?: string | null;

  @IsOptional()
  @IsString()
  socialImage?: string | null;

  @IsOptional()
  @IsEnum(['1', '2', '3'])
  access?: string;

  @IsOptional()
  @IsNumber()
  price?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsEnum(['1', '2'])
  subscription?: string;

  @IsOptional()
  @IsString()
  discount?: string;

  @IsOptional()
  @IsEnum(['draft', 'published', 'archived'])
  status?: string;

  @IsOptional()
  @IsDateString()
  availableFrom?: string;

  @IsOptional()
  @IsDateString()
  availableUntil?: string;

  @IsOptional()
  @IsEnum(['public', 'private', 'restricted'])
  visibility?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  planIds?: string[];
}

