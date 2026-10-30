import 'package:flutter_test/flutter_test.dart';
import 'package:pek_tv_ui/src/plan_ui.dart';

void main() {
  test('the yearly plan saves about a third over twelve monthly payments', () {
    expect(PlanPrices.yearlySaving.toStringAsFixed(2), '23.88');
    expect(PlanPrices.yearlySavingPercent, 33);
    expect(PlanPrices.yearlyPerMonth, '4.00');
  });
}
