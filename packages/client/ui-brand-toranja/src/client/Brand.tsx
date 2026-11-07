import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import markUrl from '../assets/toranja-mark.svg'
import wordmarkUrl from '../assets/toranja-wordmark.svg'
import css from './brand.module.css'
import { BRAND_ALT } from './locales.ts'

/**
 * Render the Toranja sidebar mark with the requested size.
 * @param props - Sidebar brand mark presentation props.
 * @returns The Toranja sidebar mark image.
 */
export function ToranjaSidebarMark({ size }: SidebarBrandMarkOwnerProps) {
  return <img className={css.mark} src={markUrl} width={size} height={size} alt="" aria-hidden="true" />
}

/**
 * Render the Toranja Tech wordmark image.
 * @returns The Toranja Tech wordmark image.
 */
export function ToranjaBrandName() {
  return <img className={css.wordmark} src={wordmarkUrl} alt={BRAND_ALT} />
}

/**
 * Render the Toranja hero brand mark.
 * @param props - Hero brand mark presentation props.
 * @returns The Toranja hero brand mark image.
 */
export function ToranjaHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  const classes = className === undefined ? css.mark : `${css.mark} ${className}`
  return <img className={classes} src={markUrl} width={size} height={size} alt="" aria-hidden="true" />
}
