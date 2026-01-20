export class User {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly email: string,
    public readonly password: string,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    public readonly phone?: string | null,
    public readonly traderMestre: boolean = false,
    public readonly derivBalance?: string | null,
  ) { }

  static create(
    id: string,
    name: string,
    email: string,
    password: string,
    phone?: string | null,
  ): User {
    const now = new Date();
    return new User(id, name, email, password, now, now, phone, false, null);
  }

  update(name?: string, email?: string, phone?: string | null): User {
    return new User(
      this.id,
      name ?? this.name,
      email ?? this.email,
      this.password,
      this.createdAt,
      new Date(),
      phone ?? this.phone,
      this.traderMestre,
      this.derivBalance,
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
      this.phone,
      this.traderMestre,
      this.derivBalance,
    );
  }
}
