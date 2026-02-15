#![allow(deprecated)]

use anchor_lang::prelude::*;

#[cfg(feature = "dev-fast-program-id")]
declare_id!("Cnraeedx3R74G42eLHBz1rTbSwCQt62C2RC7iaejWSW3");
#[cfg(not(feature = "dev-fast-program-id"))]
declare_id!("2AWsuApMg1gr4e9Ybc5Uji5cJnjYDjYaqQzjn6s6draX");

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

#[program]
pub mod openjack {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, args: InitConfigArgs) -> Result<()> {
        config::init_config(ctx, args)
    }

    pub fn set_official_scanner(
        ctx: Context<SetConfigAuthorityField>,
        new_scanner: Pubkey,
    ) -> Result<()> {
        config::set_official_scanner(ctx, new_scanner)
    }

    pub fn set_treasury(ctx: Context<SetConfigAuthorityField>, new_treasury: Pubkey) -> Result<()> {
        config::set_treasury(ctx, new_treasury)
    }

    pub fn set_ticket_price(
        ctx: Context<SetConfigAuthorityField>,
        ticket_price_usd_cents: u32,
    ) -> Result<()> {
        config::set_ticket_price(ctx, ticket_price_usd_cents)
    }

    pub fn set_oracle(
        ctx: Context<SetOracle>,
        new_oracle: Pubkey,
        max_age_secs: u32,
    ) -> Result<()> {
        config::set_oracle(ctx, new_oracle, max_age_secs)
    }

    pub fn set_vrf_callback_authority(
        ctx: Context<SetVrfAuthority>,
        new_vrf_callback_authority: Pubkey,
    ) -> Result<()> {
        config::set_vrf_callback_authority(ctx, new_vrf_callback_authority)
    }

    pub fn create_round(ctx: Context<CreateRound>, args: CreateRoundArgs) -> Result<()> {
        round::create_round(ctx, args)
    }

    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        round::close_round(ctx)
    }

    pub fn request_draw(ctx: Context<RequestDraw>, args: RequestDrawArgs) -> Result<()> {
        round::request_draw(ctx, args)
    }

    pub fn fulfill_draw(ctx: Context<FulfillDraw>, args: FulfillDrawArgs) -> Result<()> {
        round::fulfill_draw(ctx, args)
    }

    pub fn finalize_prizes(ctx: Context<FinalizePrizes>) -> Result<()> {
        round::finalize_prizes(ctx)
    }

    pub fn buy_tickets<'info>(
        ctx: Context<'_, '_, '_, 'info, BuyTickets<'info>>,
        args: BuyTicketsArgs,
    ) -> Result<()> {
        purchase::buy_tickets(ctx, args)
    }

    pub fn post_scanner_bond(ctx: Context<PostScannerBond>) -> Result<()> {
        settle::post_scanner_bond(ctx)
    }

    pub fn publish_winner_root(
        ctx: Context<PublishWinnerRoot>,
        args: PublishWinnerRootArgs,
    ) -> Result<()> {
        settle::publish_winner_root(ctx, args)
    }

    pub fn challenge_omitted_winner<'info>(
        ctx: Context<'_, '_, '_, 'info, ChallengeOmittedWinner<'info>>,
        args: ChallengeOmittedWinnerArgs,
    ) -> Result<()> {
        settle::challenge_omitted_winner(ctx, args)
    }

    pub fn claim<'info>(
        ctx: Context<'_, '_, '_, 'info, Claim<'info>>,
        args: ClaimArgs,
    ) -> Result<()> {
        claim::claim(ctx, args)
    }

    pub fn sweep_winners_to_unclaimed(ctx: Context<SweepWinnersToUnclaimed>) -> Result<()> {
        claim::sweep_winners_to_unclaimed(ctx)
    }
}
