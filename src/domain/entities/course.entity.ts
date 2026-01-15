export class Course {
  constructor(
    public readonly id: string,
    public readonly title: string,
    public readonly description: string,
    public readonly imagePlaceholder: string | null,
    public readonly totalLessons: number,
    public readonly totalDuration: string,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
