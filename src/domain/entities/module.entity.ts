export class Module {
  constructor(
    public readonly id: string,
    public readonly courseId: string,
    public readonly title: string,
    public readonly orderIndex: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
