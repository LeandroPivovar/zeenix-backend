import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsDateString,
} from 'class-validator';

export class CreateLessonDto {
  @IsString()
  courseId: string;

  @IsString()
  moduleId: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(['Video', 'Text', 'PDF', 'Link'])
  contentType?: string;

  @IsOptional()
  @IsString()
  contentLink?: string;

  @IsOptional()
  @IsEnum(['Imediata', 'Agendada'])
  releaseType?: string;

  @IsOptional()
  @IsDateString()
  releaseDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsString()
  duration: string;

  @IsOptional()
  @IsString()
  videoUrl?: string;

  @IsOptional()
  @IsNumber()
  orderIndex?: number;
}
