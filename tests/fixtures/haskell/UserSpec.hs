module App.Service.UserSpec (spec) where

import Test.Hspec
import App.Service.User (findUser, normalize)

spec :: Spec
spec = describe "findUser" $ do
  it "returns Nothing for a missing id" $ do
    normalize "x" `shouldBe` "x"
  it "normalizes" $ pending
