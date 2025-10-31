export class Lesson {
  constructor(
    public readonly id: string,
    public readonly courseId: string,
    public readonly moduleId: string | null,
    public readonly title: string,
    public readonly description: string | null,
    public readonly duration: string,
    public readonly videoUrl: string | null,
    public readonly orderIndex: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}

