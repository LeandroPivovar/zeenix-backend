export class User {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly email: string,
    public readonly password: string,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  static create(
    id: string,
    name: string,
    email: string,
    password: string,
  ): User {
    const now = new Date();
    return new User(id, name, email, password, now, now);
  }

  update(name?: string, email?: string): User {
    return new User(
      this.id,
      name ?? this.name,
      email ?? this.email,
      this.password,
      this.createdAt,
      new Date(),
    );
  }

  changePassword(newPassword: string): User {
    return new User(
      this.id,
      this.name,
      this.email,
      newPassword,
      this.createdAt,
      new Date(),
    );
  }
}
