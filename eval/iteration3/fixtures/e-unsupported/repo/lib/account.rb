class Account
  attr_reader :balance

  def initialize(balance)
    @balance = balance
  end

  def can_withdraw?(amount)
    @balance > amount
  end

  def withdraw(amount)
    raise ArgumentError, "insufficient funds" unless can_withdraw?(amount)
    @balance -= amount
  end
end
