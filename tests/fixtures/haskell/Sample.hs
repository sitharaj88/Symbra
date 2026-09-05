-- | Sample module for extractor tests.
module App.Service.User where

import qualified Data.Map as Map
import Data.Text (Text, pack)
import App.Store.Repo hiding (close)
import Control.Monad (when, forM_)
import System.Environment (getEnv, lookupEnv)

-- | A user record.
data User = User
  { userId   :: Int
  , userName :: Text
  } deriving (Show, Eq)

-- | Account status.
data Status
  = Active
  | Suspended Text
  | Closed
  deriving (Show)

newtype UserId = UserId Int

-- | Alias for a user table.
type UserTable = Map.Map Int User

-- | Things that can be stored.
class Storable a where
  storeKey :: a -> Text
  storeAll :: [a] -> Bool

instance Storable User where
  storeKey u = userName u
  storeAll xs = null xs

-- | Find a user by id.
findUser :: UserTable -> Int -> Maybe User
findUser table uid = Map.lookup uid table

renderUser :: User -> Text
renderUser (User _ n) = pack (show n)

normalize :: Text -> Text
normalize t = t

greet :: User -> Text
greet u = renderUser u

apiToken :: IO String
apiToken = getEnv "API_TOKEN"

optionalToken :: IO (Maybe String)
optionalToken = lookupEnv "OPTIONAL_TOKEN"

{- | Block haddock for the counter. -}
counter :: Int
counter = 0

prop_normalizeIdempotent :: Text -> Bool
prop_normalizeIdempotent t = normalize (normalize t) == normalize t
