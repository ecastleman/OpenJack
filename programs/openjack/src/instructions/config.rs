use anchor_lang::prelude::*;

use crate::state::LotteryConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitConfigArgs {
    pub treasury_pubkey: Pubkey,
    pub official_scanner_pubkey: Pubkey,
    pub vrf_callback_authority: Pubkey,
    pub scanner_bond_lamports: u64,
    pub scanner_slash_lamports: u64,
    pub sol_usd_oracle: Pubkey,
    pub oracle_max_age_secs: u32,
    pub ticket_price_usd_cents: u32,
    pub finder_fee_bps: u16,
    pub cadence_min_gap_secs: u32,
    pub cadence_max_gap_secs: u32,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [b"config"],
        bump,
        space = 8 + std::mem::size_of::<LotteryConfig>()
    )]
    pub config: Account<'info, LotteryConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfigAuthorityField<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, LotteryConfig>,
}

#[derive(Accounts)]
pub struct SetOracle<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, LotteryConfig>,
}

#[derive(Accounts)]
pub struct SetVrfAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, LotteryConfig>,
}

pub fn init_config(ctx: Context<InitConfig>, args: InitConfigArgs) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.authority = ctx.accounts.payer.key();
    cfg.treasury_pubkey = args.treasury_pubkey;
    cfg.official_scanner_pubkey = args.official_scanner_pubkey;
    cfg.vrf_callback_authority = args.vrf_callback_authority;
    cfg.scanner_bond_lamports = args.scanner_bond_lamports;
    cfg.scanner_slash_lamports = args.scanner_slash_lamports;
    cfg.sol_usd_oracle = args.sol_usd_oracle;
    cfg.oracle_max_age_secs = args.oracle_max_age_secs;
    cfg.ticket_price_usd_cents = args.ticket_price_usd_cents;
    cfg.finder_fee_bps = args.finder_fee_bps;
    cfg.cadence_min_gap_secs = args.cadence_min_gap_secs;
    cfg.cadence_max_gap_secs = args.cadence_max_gap_secs;
    cfg.bump = ctx.bumps.config;
    Ok(())
}

pub fn set_official_scanner(
    ctx: Context<SetConfigAuthorityField>,
    new_scanner: Pubkey,
) -> Result<()> {
    ctx.accounts.config.official_scanner_pubkey = new_scanner;
    Ok(())
}

pub fn set_treasury(ctx: Context<SetConfigAuthorityField>, new_treasury: Pubkey) -> Result<()> {
    ctx.accounts.config.treasury_pubkey = new_treasury;
    Ok(())
}

pub fn set_oracle(ctx: Context<SetOracle>, new_oracle: Pubkey, max_age_secs: u32) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.sol_usd_oracle = new_oracle;
    cfg.oracle_max_age_secs = max_age_secs;
    Ok(())
}

pub fn set_vrf_callback_authority(
    ctx: Context<SetVrfAuthority>,
    new_vrf_callback_authority: Pubkey,
) -> Result<()> {
    ctx.accounts.config.vrf_callback_authority = new_vrf_callback_authority;
    Ok(())
}
