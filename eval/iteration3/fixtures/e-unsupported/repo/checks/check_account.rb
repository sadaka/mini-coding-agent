require_relative "../lib/account"

a = Account.new(100)
a.withdraw(100)
raise "balance should be 0" unless a.balance == 0
raise "overdraft allowed" if Account.new(10).can_withdraw?(11)
puts "ok"
