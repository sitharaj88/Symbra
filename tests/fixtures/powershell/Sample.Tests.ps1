. .\Sample.psm1

Describe "Get-User" {
    It "returns a user" {
        Get-User -Name 'ada' | Should -Be 'ada'
    }
}
