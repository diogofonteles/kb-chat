// Installs a global `$localize` so `i18n` markers render under the unit-test
// builder (the pt-BR source locale returns each message as written).
import '@angular/localize/init';
import { registerLocaleData } from '@angular/common';
import localePt from '@angular/common/locales/pt';

registerLocaleData(localePt, 'pt-BR');
