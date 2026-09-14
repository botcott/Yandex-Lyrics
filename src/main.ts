import './styles/tokens.css'
import './styles/lyrics.css'

import { startAddon } from '@/app'

/**
 * Точка входа аддона.
 *
 * Оверлей вешается на `document.body`: он позиционируется фиксированно и не
 * должен зависеть от того, какой раздел клиента сейчас отрисован.
 */
startAddon(document.body)
