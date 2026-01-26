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
    public readonly firstAccess: boolean = true,
    public readonly derivBalance?: string | null,
    public readonly tokenDemo?: string | null,
    public readonly tokenReal?: string | null,
    public readonly tokenRealCurrency?: string | null,
    public readonly tokenDemoCurrency?: string | null,
    public readonly derivRaw?: any | null,
    public readonly realAmount: number = 0,
    public readonly demoAmount: number = 0,
    public readonly idRealAccount?: string | null,
    public readonly idDemoAccount?: string | null,
    public readonly role: string = 'user',
    public readonly isActive: boolean = true,
  ) { }

  static create(
    id: string,
    name: string,
    email: string,
    password: string,
    phone?: string | null,
    firstAccess: boolean = true,
  ): User {
    const now = new Date();
    return new User(id, name, email, password, now, now, phone, false, true, null, null, null, null, null, null, 0, 0, null, null, 'user', true);
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
      this.firstAccess,
      this.derivBalance,
      this.tokenDemo,
      this.tokenReal,
      this.tokenRealCurrency,
      this.tokenDemoCurrency,
      this.derivRaw,
      this.realAmount,
      this.demoAmount,
      this.idRealAccount,
      this.idDemoAccount,
      this.role,
      this.isActive,
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
      false, // Set firstAccess to false when password is changed
      this.derivBalance,
      this.tokenDemo,
      this.tokenReal,
      this.tokenRealCurrency,
      this.tokenDemoCurrency,
      this.derivRaw,
      this.realAmount,
      this.demoAmount,
      this.idRealAccount,
      this.idDemoAccount,
      this.role,
      this.isActive,
    );
  }
}
