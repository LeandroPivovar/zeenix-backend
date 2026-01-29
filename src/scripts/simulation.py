
def simulate_apollo(stop_loss=50.0, mode='conservador'):
    base_stake = 1.0
    payout_u8 = 0.19  # ~19% based on 0.19 profit on 1.0 bet
    payout_u4 = 1.20  # ~120% for Under 4

    # Profiling recovery
    profit_pct = 0.02 if mode == 'conservador' else 0.15

    print(f"--- SIMULAÇÃO APOLLO (Modificada) ---")
    print(f"Configs: Stop Loss=${stop_loss}, Modo={mode}, Base Stake=${base_stake}")
    print(f"Logica: Martingale/Recuperação ativa apenas na 2ª Derrota consecutiva.")
    print(f"        Troca para Under 4 imediata na ativação (3ª aposta).")
    print("-" * 60)
    print(f"{'#':<3} | {'Tipo':<10} | {'Stake ($)':<10} | {'Resultado':<10} | {'Saldo Sessão':<12} | {'Acum. Perda':<12}")
    print("-" * 60)

    balance = 0.0
    loss_streak = 0
    accumulated_loss = 0.0
    
    # We simulate a stream of losses to see how deep it goes
    # Bets:
    # 1. Normal (U8) -> Loss
    # 2. Normal (U8) - No Martingale yet -> Loss (Now trigger)
    # 3. Recovery (U4) -> Loss
    # 4. Recovery (U4) -> Loss
    # ...

    history = []

    for i in range(1, 20): # Simulate up to 20 steps or bust
        current_stake = 0.0
        contract = ""
        
        # LOGIC IMPLEMENTATION
        if loss_streak == 0:
            current_stake = base_stake
            contract = "U8"
        elif loss_streak == 1:
            # User Request: "activate martingale on 2nd defeat" 
            # Implication: On 1st defeat (loss_streak=1), we do NOT martingale yet?
            # Or does it mean "The bet AFTER the 2nd defeat is the first martingale"?
            # Let's assume: Loss 1 -> Retry Normal (Flat or Base).
            current_stake = base_stake 
            contract = "U8"
        else:
            # loss_streak >= 2 -> Recovery Mode Active
            # Target: Recover all accumulated loss + profit %
            target = accumulated_loss * (1 + profit_pct)
            required_profit = target
            
            # Payout varies by contract
            # User Request: "Trade contract... on recovery activation"
            # So we use U4 here.
            contract = "U4"
            
            # Stake = Required / Payout
            current_stake = required_profit / payout_u4
            
            # Precision fix
            current_stake = round(current_stake, 2)
            if current_stake < 0.35: current_stake = 0.35

        # CHECK STOP LOSS BEFORE BET
        # Note: In real trading we check if we *can* make the bet. 
        # But here we want to see the result of the *loss*.
        # So we verify if the *previous* losses + this stake exceeds Limit?
        # Usually stop loss is based on Balance.
        
        # Simulate LOSS
        loss_amount = current_stake
        balance -= loss_amount
        accumulated_loss += loss_amount
        loss_streak += 1
        
        history.append({
            'step': i,
            'contract': contract,
            'stake': current_stake,
            'balance': balance,
            'acc_loss': accumulated_loss
        })

        print(f"{i:<3} | {contract:<10} | {current_stake:<10.2f} | {'LOSS':<10} | {balance:<12.2f} | {accumulated_loss:<12.2f}")

        if abs(balance) >= stop_loss:
            print("-" * 60)
            print(f"🛑 STOP LOSS ATINGIDO NA APOSTA {i}")
            print(f"Total Investido: ${abs(balance):.2f}")
            break

simulate_apollo()
