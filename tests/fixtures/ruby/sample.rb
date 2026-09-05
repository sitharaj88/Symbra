# frozen_string_literal: true
# Sample Ruby module for extractor tests.
# Covers classes, modules, mixins, routes and specs.

require 'json'
require_relative 'helpers/util'
require_relative '../base'
autoload :Formatter, 'billing/formatter'

MAX_RETRIES = 3

module Billing
  # An invoice.
  # Second doc line.
  class Invoice < Base::Record
    include Comparable
    extend Forwardable
    prepend Loggable

    attr_reader :total, :items
    attr_accessor :status
    RATE = 0.2

    def initialize(total)
      @total = total
      @cache = Cache.new
      helper = Helper.new(1)
      helper.run
      x = Foo::Bar.baz(1, 2)
      compute(total)
      ENV['API_KEY']
      ENV.fetch('SECRET', 'x')
    end

    # Computes stuff.
    def compute(a, b = 2, *rest, k: 1, &blk)
      @cache.get(a)
      a.to_s
      super
    end

    def self.build(x)
      new(x)
    end

    def name=(v); end

    private

    def secret
      raise ArgumentError, "x" unless Klass === 1
    end

    protected

    def prot; end

    private def hidden; end

    def listed; end
    private :listed

    class << self
      def klass_m; end
    end

    alias old_compute compute
  end

  Point = Struct.new(:x, :y) do
    def dist; end
  end
end

def top_fn(x)
  Billing::Invoice.new(x)
end

get '/hello' do
  top_fn(1)
end

Rails.application.routes.draw do
  root to: 'home#index'
  get '/users', to: 'users#index'
  post 'users' => 'users#create'
  resources :posts
  resources :comments, only: [:index, :show]
  namespace :admin do
    resources :reports, only: [:index]
  end
end

RSpec.describe Billing::Invoice do
  context "when empty" do
    it "is zero" do
      get '/not/a/route'
      expect(Billing::Invoice.new(0).total).to eq(0)
    end
  end
end

class InvoiceTest < Minitest::Test
  def test_total
    assert_equal 1, 1
  end
end
